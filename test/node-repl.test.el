;;; node-repl.test.el --- Elisp integration tests for the project-level REPL -*- lexical-binding: t; -*-
;; Run: pnpm test:el (emacs --batch -Q -l test/node-repl.test.el)

(load (expand-file-name "../node-repl.el"
                     (file-name-directory (or load-file-name buffer-file-name))))

(defvar node-repl-test-root
  (expand-file-name ".." (file-name-directory (or load-file-name buffer-file-name))))

(defun assert-t (cond label)
  (unless cond (error "FAIL %s" label))
  (princ (format "PASS %s\n" label)))

(defun wait-for (proc pred deadline-secs)
  (let ((deadline (+ (float-time) deadline-secs)))
    (while (and (not (funcall pred)) (< (float-time) deadline))
      (accept-process-output proc 0.5))))

(defun server-buffer-text ()
  (with-current-buffer (node-repl--buffer (node-repl-current-server))
    (buffer-string)))

;; 1. Buffer without package.json: ensure rejected
(with-temp-buffer
  (setq default-directory "/tmp/")
  (condition-case e
      (progn (node-repl-ensure)
             (error "FAIL: start in non-project accepted"))
    (error (princ "PASS non-project start rejected\n"))))

;; 2. eval without a running instance: rejected
(with-temp-buffer
  (setq default-directory node-repl-test-root)
  (condition-case e
      (progn (node-repl-eval "1 + 1")
             (error "FAIL: eval without start accepted"))
    (error (princ "PASS eval without start rejected\n"))))

;; 3. Project A (node-repl itself): TS + import + TLA
(with-temp-buffer
  (setq default-directory node-repl-test-root)
  (let ((server (node-repl-ensure)))
    (assert-t (eq server (node-repl-current-server)) "A current server")
    (node-repl-eval "import { parse } from 'acorn';\nconst r = await Promise.resolve(1);\nparse('1+1').body.length + r")
    (wait-for (node-repl--process server)
              (lambda () (string-match-p (regexp-quote "2\n\n") (server-buffer-text)))
              5)
    (assert-t (string-match-p (regexp-quote "import { parse } from 'acorn';")
                              (server-buffer-text))
              "A import prompt")
    (assert-t (string-match-p (regexp-quote "2\n\n") (server-buffer-text))
              "A import + TLA result")
    (node-repl-eval "var iso = 'A'")
    (wait-for (node-repl--process server)
              (lambda () (string-match-p (regexp-quote "> var iso = 'A'\n=> undefined\n\n")
                                         (server-buffer-text)))
              5)
    (assert-t (string-match-p (regexp-quote "> var iso = 'A'\n=> undefined\n\n")
                              (server-buffer-text))
              "A define var")
    (setq node-repl-test-proj-a server)))

;; 4. Project B (auto-bidding-v2): separate instance + variable isolation + project deps
(with-temp-buffer
  (setq default-directory (expand-file-name "../auto-bidding-v2" node-repl-test-root))
  (let ((server (node-repl-ensure)))
    (assert-t (not (eq server node-repl-test-proj-a)) "B is separate instance")
    (node-repl-eval "typeof iso")
    (wait-for (node-repl--process server)
              (lambda () (string-match-p (regexp-quote "> typeof iso\n=> 'undefined'\n\n")
                                         (server-buffer-text)))
              5)
    (assert-t (string-match-p (regexp-quote "> typeof iso\n=> 'undefined'\n\n")
                              (server-buffer-text))
              "B isolated from A")
    (node-repl-eval "require('typescript').version")
    (wait-for (node-repl--process server)
              (lambda () (string-match-p (regexp-quote "> require('typescript').version\n=> '6.0.3'\n\n")
                                         (server-buffer-text)))
              5)
    (assert-t (string-match-p (regexp-quote "> require('typescript').version\n=> '6.0.3'\n\n")
                              (server-buffer-text))
              "B eval with project require")
    (setq node-repl-test-proj-b server)))

;; 4b. Relative-path import resolves against the code's directory (fileDir)
(with-temp-buffer
  (setq default-directory (expand-file-name "test/fixtures" node-repl-test-root))
  (let ((server (node-repl-current-server)))
    (unless server (setq server (node-repl-ensure)))
    (node-repl-eval "import { VK } from './constants'; VK")
    (wait-for (node-repl--process server)
              (lambda () (string-match-p (regexp-quote "=> 'vk-value'\n\n")
                                         (server-buffer-text)))
              5)
    (assert-t (string-match-p (regexp-quote "=> 'vk-value'\n\n")
                              (server-buffer-text))
              "relative import via fileDir")))

;; 4c. console output: number/boolean args shown literally, filter stays intact
(with-temp-buffer
  (setq default-directory node-repl-test-root)
  (let* ((server node-repl-test-proj-a)
         (buf (node-repl--buffer server)))
    (node-repl-eval "console.log(0); console.log('a', 1, true, false); 1")
    (wait-for (node-repl--process server)
              (lambda () (string-match-p "a 1 true"
                                         (with-current-buffer buf (buffer-string))))
              5)
    (assert-t (string-match-p
               (regexp-quote "> console.log(0); console.log('a', 1, true, false); 1\n0\na 1 true false\n=> 1\n\n")
               (with-current-buffer buf (buffer-string)))
              "console args formatted")))

;; 5. Index lookup: a fresh buffer (same project A) finds the instance without cache
(with-temp-buffer
  (setq default-directory node-repl-test-root)
  (assert-t (eq (node-repl-current-server) node-repl-test-proj-a)
            "index lookup from fresh buffer"))

;; 6. Keybinding idempotence: two instances coexist, bindings installed once
(assert-t node-repl--bindings-active "bindings active with 2 instances")
(assert-t (= (length node-repl--saved-bindings) 3) "bindings saved once")

;; 7. Shut down A: A's eval rejected, B still works
(node-repl--shutdown-server node-repl-test-proj-a)
(assert-t (not (gethash (expand-file-name node-repl-test-root)
                        node-repl--servers-by-project))
          "A removed from index")
(with-temp-buffer
  (setq default-directory node-repl-test-root)
  (condition-case e
      (progn (node-repl-eval "1 + 1")
             (error "FAIL: eval on stopped A accepted"))
    (error (princ "PASS eval on stopped A rejected\n"))))
(with-temp-buffer
  (setq default-directory (expand-file-name "../auto-bidding-v2" node-repl-test-root))
  (node-repl-eval "1 + 1")
  (wait-for (node-repl--process node-repl-test-proj-b)
            (lambda () (string-match-p (regexp-quote "> 1 + 1\n=> 2\n\n")
                                       (server-buffer-text)))
            5)
  (assert-t (string-match-p (regexp-quote "> 1 + 1\n=> 2\n\n")
                            (server-buffer-text))
            "B still works after A stopped"))

;; 8. Shut down B: all bindings restored
(node-repl--shutdown-server node-repl-test-proj-b)
(assert-t (not node-repl--bindings-active) "bindings restored after all stopped")
(assert-t (null node-repl--saved-bindings) "saved bindings cleared")

(princ "ALL PASS\n")
