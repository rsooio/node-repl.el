;;; node-repl.el --- Drive the evaluator stdio REPL from Emacs -*- lexical-binding: t; -*-

;;; Commentary:

;; 项目级 node-repl：每个项目（由 package.json 标识）一个独立 REPL 实例，
;; 模型与 eglot 一致——实例自包含、buffer-local 关联、索引仅用于查找：
;;
;;   (node-repl-start)   在当前 buffer 的项目手动启动 REPL（已运行则询问重启）
;;   (node-repl-stop)    停止当前项目的 REPL
;;   (node-repl-eval)    求值当前 JS/TS 文件顶层节点或选区，未启动则提示
;;
;; 启动后 C-M-x 在 js/ts treesit major mode 中绑定到 node-repl-eval（任一
;; 实例运行时绑定，全部停止后恢复）。代码与结果以 REPL transcript 形式
;; 显示在 *node-repl: <包名>* buffer：
;;
;;                         > 1 + 1
;;                         2
;;
;; 协议（JSONL，UTF-8）：
;;   请求：一行 JSON  {"code": "<JS/TS 代码>", "cwd": "<项目根>"}
;;   响应：一行 JSON：
;;     {"type": "result",  "result": "<结果或错误文本>"}
;;     {"type": "console", "method": "log", "args": "<inspect 文本>"}
;;
;; 服务端用 esbuild 擦除 TS 类型后求值，并向 context 注入项目的
;; createRequire（代码内可用 require() 加载项目依赖）。变量跨请求保留。

;;; Code:

(require 'json)
(require 'cl-lib)

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

;;; 实例结构（自包含，无外部管理器）

(cl-defstruct (node-repl--server
               (:constructor node-repl--make-server)
               (:conc-name node-repl--))
  project        ; 项目根目录
  process        ; node-repl 主进程
  stderr         ; stderr 转发 pipe process
  buffer         ; *node-repl: <包名>*
  output         ; stdout 未解析缓冲
  queue)         ; 响应回调队列（FIFO）

;;; 查找索引（仅用于按项目查找实例，无生命周期职责）

(defvar node-repl--servers-by-project (make-hash-table :test #'equal))

;;; buffer-local 关联缓存（eglot--cached-server 同款）

(defvar-local node-repl--server nil
  "当前 buffer 关联的 REPL 实例，nil 表示未关联。")

(defvar node-repl--saved-bindings nil
  "已保存的 C-M-x 原绑定：((KEYMAP . COMMAND) ...)")
(defvar node-repl--bindings-active nil
  "C-M-x 绑定是否已生效（任一实例运行时为 t）。")

(defvar node-repl--mode-map-symbols
  '(javascript-ts-mode-map js-ts-mode-map typescript-ts-mode-map tsx-ts-mode-map)
  "要绑定的 major mode keymap 符号（按存在性逐个启用）。")

;;; 工具

(defun node-repl--tsx-path ()
  (let ((local (expand-file-name
                "node_modules/.bin/tsx"
                (file-name-directory node-repl-script-path))))
    (cond ((file-executable-p local) local)
          ((executable-find node-repl-tsx-command))
          (t (error "未找到 tsx，请设置 node-repl-tsx-command")))))

(defun node-repl--project-root ()
  "当前 buffer 的项目根（向上找 package.json，统一为绝对路径），nil 表示不在项目中。"
  (when-let* ((dir (locate-dominating-file default-directory "package.json")))
    (expand-file-name dir)))

(defun node-repl--project-name (project)
  "取项目的包名，失败时回退目录名。"
  (let ((pkg (expand-file-name "package.json" project)))
    (condition-case nil
        (or (alist-get 'name (json-read-file pkg))
            (file-name-nondirectory (directory-file-name project)))
      (error (file-name-nondirectory (directory-file-name project))))))

(defun node-repl--append (buffer text &optional face)
  "在 BUFFER 末尾追加 TEXT（可选 FACE 高亮），并滚动到可见位置。"
  (when buffer
    (with-current-buffer buffer
      (goto-char (point-max))
      (let ((inhibit-read-only t))
        (insert (if face (propertize text 'face face) text)))
      (let ((win (get-buffer-window buffer t)))
        (when win (set-window-point win (point-max)))))))

;;; 请求/响应

(defun node-repl--dispatch (server result)
  (let ((callback (pop (node-repl--queue server))))
    (when callback
      (funcall callback result))))

(defun node-repl--filter (server string)
  (setf (node-repl--output server) (concat (node-repl--output server) string))
  (while (string-match "\n" (node-repl--output server))
    (let ((line (substring (node-repl--output server) 0 (match-beginning 0))))
      (setf (node-repl--output server)
            (substring (node-repl--output server) (match-end 0)))
      (when (string-match-p "[^[:space:]]" line)
        (let* ((msg (condition-case nil
                        (json-read-from-string line)
                      ;; 容错：非 JSON 行（如模块泄漏的原生输出）原样显示，不中断 filter
                      (error nil))))
          (if (null msg)
              (node-repl--append (node-repl--buffer server)
                                 (format "%s\n" line))
            (pcase (alist-get 'type msg)
              ("result"
               (node-repl--dispatch server (alist-get 'result msg)))
              ("console"
               (node-repl--append
                (node-repl--buffer server)
                (format "%s\n" (string-join (alist-get 'args msg) " ")))))))))))

(defun node-repl--sentinel (server _event)
  (when (string-match-p "\\`\\(finished\\|deleted\\)" _event)
    ;; 实例自己从索引摘除（eglot--on-shutdown 同款）
    (remhash (node-repl--project server) node-repl--servers-by-project)
    (when (eq node-repl--server server)
      (setq node-repl--server nil))
    (while (node-repl--queue server)
      (let ((callback (pop (node-repl--queue server))))
        (when callback
          (funcall callback "REPL 进程已退出"))))
    (node-repl--maybe-restore-keybindings)))

;;; C-M-x 绑定（幂等：任一实例运行时绑定，全部停止后恢复）

(defun node-repl--ensure-keybindings ()
  (unless node-repl--bindings-active
    (require 'js)
    (require 'typescript-ts-mode)
    (dolist (sym node-repl--mode-map-symbols)
      (when (and (boundp sym) (keymapp (symbol-value sym)))
        (let ((map (symbol-value sym)))
          (push (cons map (lookup-key map (kbd "C-M-x")))
                node-repl--saved-bindings)
          (keymap-set map "C-M-x" #'node-repl-eval))))
    (setq node-repl--bindings-active t)))

(defun node-repl--maybe-restore-keybindings ()
  (when (and node-repl--bindings-active
             (zerop (hash-table-count node-repl--servers-by-project)))
    (dolist (entry node-repl--saved-bindings)
      (keymap-set (car entry) "C-M-x" (cdr entry)))
    (setq node-repl--saved-bindings nil
          node-repl--bindings-active nil)))

;;; 实例生命周期

(defun node-repl--start-server (project)
  (let* ((name (node-repl--project-name project))
         (buffer (get-buffer-create (format "*node-repl: %s*" name)))
         (server (node-repl--make-server :project project :buffer buffer)))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer))
      (setq default-directory project)
      ;; 只读展示：不提供 buffer 内输入，进程输出不受 read-only 影响
      (read-only-mode 1))
    (setf (node-repl--stderr server)
          (make-pipe-process
           :name (format "node-repl-stderr-%s" name)
           :coding '(utf-8-unix . utf-8-unix)
           :filter (lambda (_proc string)
                     (node-repl--append buffer string))
           :noquery t)
          (node-repl--process server)
          (make-process
           :name (format "node-repl-%s" name)
           :buffer buffer
           :command (list (node-repl--tsx-path) node-repl-script-path)
           :coding '(utf-8-unix . utf-8-unix)
           ;; 显式指定 pipe：batch 模式下默认不创建 stdin 管道，数据无法到达子进程
           :connection-type 'pipe
           :filter (lambda (_proc string) (node-repl--filter server string))
           :sentinel (lambda (proc event) (node-repl--sentinel server event))
           :stderr (node-repl--stderr server)
           :noquery t))
    (puthash project server node-repl--servers-by-project)
    (setq node-repl--server server)
    (node-repl--ensure-keybindings)
    (message "node-repl 已启动：%s" name)
    server))

(defun node-repl--stop-server (server)
  (when (process-live-p (node-repl--process server))
    (delete-process (node-repl--process server)))
  (remhash (node-repl--project server) node-repl--servers-by-project)
  (when (eq node-repl--server server)
    (setq node-repl--server nil))
  (node-repl--maybe-restore-keybindings))

;;; 公开 API

(defun node-repl-current-server ()
  "返回当前 buffer 关联的 REPL 实例，nil 表示未启动。"
  (or node-repl--server
      (when-let* ((project (node-repl--project-root)))
        (setq node-repl--server
              (gethash project node-repl--servers-by-project)))))

(defun node-repl-start ()
  "在当前 buffer 的项目手动启动 REPL。
已运行时：交互式调用询问是否重启（类似 eglot），程序化调用返回现有实例。"
  (interactive)
  (let* ((project (node-repl--project-root))
         (server (and project (gethash project node-repl--servers-by-project))))
    (unless project
      (user-error "当前 buffer 不在项目中（找不到 package.json）"))
    (if server
        (if (called-interactively-p 'any)
            (when (y-or-n-p
                   (format "项目 %s 的 node-repl 已在运行，重启？"
                           (node-repl--project-name project)))
              (node-repl--stop-server server)
              (node-repl-start))
          server)
      (node-repl--start-server project))))

(defun node-repl-stop ()
  "停止当前项目的 REPL。"
  (interactive)
  (let ((server (node-repl-current-server)))
    (if server
        (node-repl--stop-server server)
      (user-error "当前项目的 node-repl 未启动"))))

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
  "在当前项目的 REPL 中求值 CODE，代码与响应追加到该实例的 transcript buffer。

交互式调用时 CODE 取当前 JS/TS 文件顶层节点或选区（见 `node-repl--code'）。"
  (interactive (list (string-trim (node-repl--code))))
  (unless code
    (user-error "没有可求值的代码：需在 JS/TS 文件顶层节点上或选中区域"))
  (let ((server (node-repl-current-server)))
    (unless server
      (user-error "当前项目的 node-repl 未启动，先执行 M-x node-repl-start"))
    (node-repl--append (node-repl--buffer server)
                       (format "> %s\n" (string-replace "\n" "\n> " code))
                       'comint-highlight-prompt)
    (setf (node-repl--queue server)
          (append (node-repl--queue server)
                  (list (lambda (r)
                          (node-repl--append (node-repl--buffer server)
                                             (format "=> %s\n\n" r))))))
    (process-send-string
     (node-repl--process server)
     (concat (json-encode `(("code" . ,code)
                            ("cwd" . ,(node-repl--project server))
                            ("fileDir" . ,(or (and buffer-file-name
                                                    (file-name-directory
                                                     buffer-file-name))
                                               default-directory))))
             "\n")))
  nil)

(provide 'node-repl)

;;; node-repl.el ends here
