;;; node-repl.el --- Drive the evaluator stdio REPL from Emacs -*- lexical-binding: t; -*-

;;; Commentary:

;; Project-level node-repl: one REPL instance per project (identified by
;; package.json), modeled after eglot -- self-contained instances, buffer-local
;; association, and an index used only for lookup:
;;
;;   (node-repl-ensure)    Ensure a REPL runs for the current project (asks to restart if running)
;;   (node-repl-shutdown)  Shut down the REPL of the current project
;;   (node-repl-eval)      Evaluate the top-level JS/TS node at point or the region, if not started
;;
;; Once started, C-M-x is bound to node-repl-eval in js/ts treesit major modes
;; (bound while any instance runs, restored when all stop). Code and results
;; are shown as a REPL transcript in the *node-repl: <package>* buffer:
;;
;;                         > 1 + 1
;;                         2
;;
;; Protocol (JSONL, UTF-8):
;;   Request: one JSON line  {"code": "<JS/TS code>", "cwd": "<project root>"}
;;   Response: one JSON line:
;;     {"type": "result",  "result": "<result or error text>"}
;;     {"type": "console", "method": "log", "args": ["<string args as-is>", <number/boolean args as-is>]}
;;
;; The server runs repl.ts directly with node (Node >= 23.6 native TS type
;; stripping); module syntax is transpiled by sucrase before evaluation, and
;; the project's createRequire is injected into the context (code can load
;; project dependencies with require()). Variables persist across requests.

;;; Code:

(require 'json)
(require 'cl-lib)

(defgroup node-repl nil
  "Node evaluator stdio REPL."
  :group 'processes)

(defcustom node-repl-node-command "node"
  "Executable name or path of the node binary.
Requires Node >= 23.6 (native TS type stripping enabled by default)."
  :type 'string
  :group 'node-repl)

(defcustom node-repl-script-path
  (expand-file-name
   "repl.ts"
   (file-name-directory (or load-file-name buffer-file-name default-directory)))
  "Path to the REPL entry script repl.ts."
  :type 'file
  :group 'node-repl)

;;; Instance structure (self-contained, no external manager)

(cl-defstruct (node-repl--server
               (:constructor node-repl--make-server)
               (:conc-name node-repl--))
  project          ; project root directory
  process          ; node-repl main process
  stderr           ; stderr forwarding pipe process
  buffer           ; *node-repl: <package>*
  output           ; unparsed stdout buffer
  queue            ; response callback queue (FIFO)
  managed-buffers) ; associated buffers (like eglot--managed-buffers); caches cleared on stop/exit

;;; Lookup index (instance lookup by project only, no lifecycle duties)

(defvar node-repl--servers-by-project (make-hash-table :test #'equal))

;;; Buffer-local association cache (like eglot--cached-server)

(defvar-local node-repl--cached-server nil
  "A cached reference to the REPL instance for this buffer, nil if not associated.")

(defvar node-repl--saved-bindings nil
  "Saved C-M-x bindings: ((KEYMAP . COMMAND) ...)")
(defvar node-repl--bindings-active nil
  "Non-nil while the C-M-x bindings are installed (any instance running).")

(defvar node-repl--mode-map-symbols
  '(javascript-ts-mode-map js-ts-mode-map typescript-ts-mode-map tsx-ts-mode-map)
  "Major-mode keymap symbols to bind C-M-x in (enabled per availability).")

;;; Utilities

(defun node-repl--node-path ()
  (or (executable-find node-repl-node-command)
      (error "node not found; set `node-repl-node-command'")))

(defun node-repl--project-root ()
  "Project root of the current buffer (nearest ancestor with package.json, absolute), nil if not in a project."
  (when-let* ((dir (locate-dominating-file default-directory "package.json")))
    (expand-file-name dir)))

(defun node-repl--project-name (project)
  "Package name of PROJECT, falling back to the directory name."
  (let ((pkg (expand-file-name "package.json" project)))
    (condition-case nil
        (or (alist-get 'name (json-read-file pkg))
            (file-name-nondirectory (directory-file-name project)))
      (error (file-name-nondirectory (directory-file-name project))))))

(defun node-repl--append (buffer text &optional face)
  "Append TEXT to BUFFER (optionally with FACE) and scroll it into view."
  (when buffer
    (with-current-buffer buffer
      (goto-char (point-max))
      (let ((inhibit-read-only t))
        (insert (if face (propertize text 'face face) text)))
      (let ((win (get-buffer-window buffer t)))
        (when win (set-window-point win (point-max)))))))

;;; Request/response

(defun node-repl--dispatch (server result)
  (let ((callback (pop (node-repl--queue server))))
    (when callback
      (funcall callback result))))

(defun node-repl--console-args (args)
  "Format ARGS of a console message for display.
Strings are shown as-is; numbers/booleans (parsed by json.el as
number/t/json-false, JSON null as nil) are shown literally."
  (mapconcat
   (lambda (a)
     (cond ((stringp a) a)
           ((null a) "null")
           ((eq a json-false) "false")
           ((eq a t) "true")
           ((numberp a) (number-to-string a))
           (t (format "%S" a))))
   args " "))

(defun node-repl--filter (server string)
  (setf (node-repl--output server) (concat (node-repl--output server) string))
  (while (string-match "\n" (node-repl--output server))
    (let ((line (substring (node-repl--output server) 0 (match-beginning 0))))
      (setf (node-repl--output server)
            (substring (node-repl--output server) (match-end 0)))
      (when (string-match-p "[^[:space:]]" line)
        (let* ((msg (condition-case nil
                        (json-read-from-string line)
                      ;; Tolerate non-JSON lines (e.g. raw output leaked by
                      ;; modules): show as-is, keep the filter alive
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
                (format "%s\n"
                        (node-repl--console-args (alist-get 'args msg))))))))))))

(defun node-repl--clear-buffer-caches (server)
  "Clear the cached SERVER reference in all buffers associated with it.
Called when SERVER stops or exits: the sentinel only clears the local
value in the current buffer, leaving stale instances in other buffers
(the eglot--on-shutdown walk over managed-buffers, adapted)."
  (dolist (buffer (node-repl--managed-buffers server))
    (when (buffer-live-p buffer)
      (with-current-buffer buffer
        (when (eq node-repl--cached-server server)
          (setq node-repl--cached-server nil)))))
  (setf (node-repl--managed-buffers server) nil))

(defun node-repl--sentinel (server _event)
  ;; Clean up on any terminal event (finished/killed/hangup/exited...): a
  ;; dead process is unusable, so the index, keybindings, queue and all
  ;; buffer-local caches are invalidated (like eglot--on-shutdown)
  (node-repl--clear-buffer-caches server)
  (remhash (node-repl--project server) node-repl--servers-by-project)
  (while (node-repl--queue server)
    (let ((callback (pop (node-repl--queue server))))
      (when callback
        (funcall callback "REPL process exited"))))
  (node-repl--maybe-restore-keybindings))

;;; C-M-x bindings (idempotent: installed while any instance runs, restored when all stop)

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

;;; Instance lifecycle

(defun node-repl--connect (project)
  (let* ((name (node-repl--project-name project))
         (buffer (get-buffer-create (format "*node-repl: %s*" name)))
         (server (node-repl--make-server :project project :buffer buffer)))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer))
      (setq default-directory project)
      ;; Read-only display: no input in the buffer; process output is
      ;; unaffected by read-only
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
           :command (list (node-repl--node-path) node-repl-script-path)
           :coding '(utf-8-unix . utf-8-unix)
           ;; Explicit pipe: batch mode creates no stdin pipe by default,
           ;; so data would never reach the child
           :connection-type 'pipe
           :filter (lambda (_proc string) (node-repl--filter server string))
           :sentinel (lambda (proc event) (node-repl--sentinel server event))
           :stderr (node-repl--stderr server)
           :noquery t))
    (puthash project server node-repl--servers-by-project)
    (setq node-repl--cached-server server)
    (cl-pushnew (current-buffer) (node-repl--managed-buffers server))
    (node-repl--ensure-keybindings)
    (message "node-repl started: %s" name)
    server))

(defun node-repl--shutdown-server (server)
  (when (process-live-p (node-repl--process server))
    ;; delete-process triggers the sentinel synchronously (cleanup is
    ;; idempotent; this is the fallback for the dead-process path)
    (delete-process (node-repl--process server)))
  (node-repl--clear-buffer-caches server)
  (remhash (node-repl--project server) node-repl--servers-by-project)
  (node-repl--maybe-restore-keybindings))

;;; Public API

(defun node-repl-current-server ()
  "Return the REPL instance associated with the current buffer, nil if none.
Registers the current buffer with the instance (like eglot--managed-buffers)
so its cached reference is cleared when the instance stops or exits."
  (let ((server (or node-repl--cached-server
                    (when-let* ((project (node-repl--project-root)))
                      (gethash project node-repl--servers-by-project)))))
    (when server
      (setq node-repl--cached-server server)
      (cl-pushnew (current-buffer) (node-repl--managed-buffers server)))
    server))

(defun node-repl-ensure ()
  "Ensure a REPL instance for the current project is running.
If one is already running: interactively ask whether to restart (like
eglot), programmatically return the existing instance."
  (interactive)
  (let* ((project (node-repl--project-root))
         (server (and project (gethash project node-repl--servers-by-project))))
    (unless project
      (user-error "Current buffer is not in a project (no package.json found)"))
    (if server
        (if (called-interactively-p 'any)
            (when (y-or-n-p
                   (format "node-repl for project %s is already running; restart? "
                           (node-repl--project-name project)))
              (node-repl--shutdown-server server)
              (node-repl-ensure))
          server)
      (node-repl--connect project))))

(defun node-repl-shutdown ()
  "Shut down the REPL of the current project."
  (interactive)
  (let ((server (node-repl-current-server)))
    (if server
        (node-repl--shutdown-server server)
      (user-error "No node-repl instance is running for the current project"))))

(defun node-repl--code ()
  "Text of the top-level node at point in the current JS/TS file, or the active region if any."
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
  "Evaluate CODE in the REPL of the current project.

Interactively, CODE is the top-level node at point or the active region
(see `node-repl--code')."
  (interactive (list (string-trim (node-repl--code))))
  (unless code
    (user-error "Nothing to evaluate: point is not on a top-level JS/TS node and no region is active"))
  (let ((server (node-repl-current-server)))
    (unless server
      (user-error "No node-repl instance is running; run M-x node-repl-ensure"))
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
