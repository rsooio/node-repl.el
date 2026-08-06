;;; node-repl.el --- Drive the evaluator stdio REPL from Emacs -*- lexical-binding: t; -*-

;;; Commentary:

;; 在 Emacs 内驱动 node-repl（tsx repl.ts）的 JSONL 协议：
;;   请求：一行 JSON  {"code": "<JS 代码>"}
;;   响应：一行 JSON：
;;     {"type": "result",  "result": "<结果或错误文本>"}
;;     {"type": "console", "method": "log", "args": "<inspect 文本>"}
;;
;; 基本用法：
;;   M-x node-repl-start  启动 REPL（已运行时询问是否重启），启动后
;;                        C-M-x 在 javascript-ts-mode / typescript-ts-mode
;;                        中绑定到求值；M-x node-repl-stop 停止并恢复绑定
;;   M-x node-repl-eval  求值当前 JS/TS 文件顶层节点或选区，
;;                       代码与结果以 REPL transcript 形式显示在
;;                       *node-repl* buffer：
;;
;;                         > 1 + 1
;;                         2
;;
;;   (node-repl-eval "1 + 1")  程序化调用，同上。
;;
;; 结果文本是 util.inspect 的输出（字符串带引号和转义），错误文本为 JS
;; 错误信息，两者不区分。console 消息与进程 stderr 一起显示在
;; *node-repl* buffer 中。变量跨请求保留：class/函数/变量声明在后续
;; eval 中持续可用。

;;; Code:

(require 'json)

(defgroup node-repl nil
  "Node evaluator stdio REPL."
  :group 'processes)

(defcustom node-repl-tsx-command "tsx"
  "tsx 可执行文件名或路径。
找不到时回退到脚本目录下的 node_modules/.bin/tsx。"
  :type 'string
  :group 'node-repl)

(defcustom node-repl-script-path
  (expand-file-name
   "repl.ts"
   (file-name-directory (or load-file-name buffer-file-name default-directory)))
  "REPL 入口脚本 repl.ts 的路径。"
  :type 'file
  :group 'node-repl)

(defvar node-repl--process nil)
(defvar node-repl--buffer nil)
(defvar node-repl--stderr nil)
(defvar node-repl--output "")
(defvar node-repl--queue nil)

(defvar node-repl--saved-bindings nil
  "启动时保存的 C-M-x 原绑定，停止时恢复：((KEYMAP . COMMAND) ...)")

(defvar node-repl--mode-map-symbols
  '(javascript-ts-mode-map js-ts-mode-map typescript-ts-mode-map tsx-ts-mode-map)
  "要绑定的 major mode keymap 符号（按存在性逐个启用）。")

(defun node-repl--enable-keybindings ()
  "将 C-M-x 绑定到 `node-repl-eval'（js/ts 的 treesit major mode）。"
  (require 'js)
  (require 'typescript-ts-mode)
  (dolist (sym node-repl--mode-map-symbols)
    (when (and (boundp sym) (keymapp (symbol-value sym)))
      (let ((map (symbol-value sym)))
        (push (cons map (lookup-key map (kbd "C-M-x")))
              node-repl--saved-bindings)
        (keymap-set map "C-M-x" #'node-repl-eval)))))

(defun node-repl--disable-keybindings ()
  "恢复 C-M-x 的原绑定。"
  (dolist (entry node-repl--saved-bindings)
    (keymap-set (car entry) "C-M-x" (cdr entry)))
  (setq node-repl--saved-bindings nil))

(defun node-repl--tsx-path ()
  (let ((local (expand-file-name
                "node_modules/.bin/tsx"
                (file-name-directory node-repl-script-path))))
    (cond ((file-executable-p local) local)
          ((executable-find node-repl-tsx-command))
          (t (error "未找到 tsx，请设置 node-repl-tsx-command")))))

(defun node-repl--append (text &optional face)
  "在 *node-repl* buffer 末尾追加 TEXT（可选 FACE 高亮），并滚动到可见位置。"
  (when node-repl--buffer
    (with-current-buffer node-repl--buffer
      (goto-char (point-max))
      (let ((inhibit-read-only t))
        (insert (if face (propertize text 'face face) text)))
      (let ((win (get-buffer-window node-repl--buffer t)))
        (when win (set-window-point win (point-max)))))))

(defun node-repl--dispatch (result)
  (let ((callback (pop node-repl--queue)))
    (when callback
      (funcall callback result))))

(defun node-repl--filter (_proc string)
  (setq node-repl--output (concat node-repl--output string))
  (while (string-match "\n" node-repl--output)
    (let ((line (substring node-repl--output 0 (match-beginning 0))))
      (setq node-repl--output (substring node-repl--output (match-end 0)))
      (when (string-match-p "[^[:space:]]" line)
        (let* ((msg (json-read-from-string line))
               (type (alist-get 'type msg)))
          (pcase type
            ("result" (node-repl--dispatch (alist-get 'result msg)))
            ("console"
             (node-repl--append
              (format "%s %s\n"
                      (alist-get 'method msg)
                      (alist-get 'args msg))))))))))

(defun node-repl--sentinel (_proc event)
  (when (string-match-p "\\`\\(finished\\|deleted\\)" event)
    (setq node-repl--process nil)
    (while node-repl--queue
      (let ((callback (pop node-repl--queue)))
        (when callback
          (funcall callback "REPL 进程已退出"))))))

(defun node-repl--start-process ()
  (let ((tsx (node-repl--tsx-path)))
    (setq node-repl--buffer (get-buffer-create "*node-repl*"))
    (with-current-buffer node-repl--buffer
      (let ((inhibit-read-only t))
        (erase-buffer))
      (setq default-directory (file-name-directory node-repl-script-path))
      ;; 只读展示：不提供 buffer 内输入，进程输出不受 read-only 影响
      (read-only-mode 1))
    (setq node-repl--output ""
          node-repl--queue nil
          ;; stderr 也走自定义 filter，与 stdout 统一按到达顺序追加到 transcript
          node-repl--stderr
          (make-pipe-process
           :name "node-repl-stderr"
           :coding '(utf-8-unix . utf-8-unix)
           :filter (lambda (_proc string) (node-repl--append string))
           :noquery t)
          node-repl--process
          (make-process
           :name "node-repl"
           :buffer node-repl--buffer
           :command (list tsx node-repl-script-path)
           :coding '(utf-8-unix . utf-8-unix)
           ;; 显式指定 pipe：batch 模式下默认不创建 stdin 管道，数据无法到达子进程
           :connection-type 'pipe
           :filter #'node-repl--filter
           :sentinel #'node-repl--sentinel
           :stderr node-repl--stderr
           :noquery t)))
  (node-repl--enable-keybindings)
  (message "node-repl 已启动")
  node-repl--process)

(defun node-repl-start ()
  "启动 node-repl 进程。\n\n已运行时：交互式调用询问是否重启（类似 eglot），程序化调用直接返回现有进程。"
  (interactive)
  (if (process-live-p node-repl--process)
      (if (called-interactively-p 'any)
          (when (y-or-n-p "node-repl 已在运行，重启？")
            (node-repl-stop)
            (node-repl-start))
        node-repl--process)
    (node-repl--start-process)))

(defun node-repl-stop ()
  "停止 node-repl 进程。"
  (interactive)
  (when (process-live-p node-repl--process)
    (delete-process node-repl--process))
  (setq node-repl--process nil)
  (node-repl--disable-keybindings))

(defun node-repl--code ()
  "取当前 JS/TS 文件的顶层节点文本；有活动选区时取选区文本。"
  (if (region-active-p)
      (buffer-substring-no-properties (region-beginning) (region-end))
    (when-let* ((node (treesit-parent-until
                       (treesit-node-at (point))
                       (lambda (n)
                         (member (treesit-node-type (treesit-node-parent n))
                                 '("program" "module"))))))
      (buffer-substring-no-properties (treesit-node-start node)
                                      (treesit-node-end node)))))

(defun node-repl-eval (code)
  "在 REPL 中求值 CODE，代码与响应以 REPL transcript 形式追加到 *node-repl* buffer。

交互式调用时 CODE 取当前 JS/TS 文件顶层节点或选区（见 `node-repl--code'）。"
  (interactive (list (node-repl--code)))
  (unless code
    (user-error "没有可求值的代码：需在 JS/TS 文件顶层节点上或选中区域"))
  (unless (process-live-p node-repl--process)
    (node-repl-start))
  (node-repl--append (format "> %s\n" code) 'comint-highlight-prompt)
  (setq node-repl--queue
        (append node-repl--queue
                (list (lambda (r) (node-repl--append (format "%s\n\n" r))))))
  (process-send-string node-repl--process
                       (concat (json-encode (list (cons "code" code))) "\n"))
  nil)

(provide 'node-repl)

;;; node-repl.el ends here
