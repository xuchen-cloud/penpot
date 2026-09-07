(ns frontend-tests.style-test
  (:require
   [app.main.style :as style]
   [clojure.test :refer [deftest is]]))

(deftest css-prefix-is-platform-independent
  (is (= "main_ui_workspace__"
         (style/get-prefix "app/main/ui/workspace.cljs")))
  (is (= "main_ui_workspace__"
         (style/get-prefix "app\\main\\ui\\workspace.cljs"))))
