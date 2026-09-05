(ns exporter-tests.browser-test
  (:require
   [app.browser :as browser]
   [app.config :as cf]
   [cljs.test :as t :include-macros true]))

(t/deftest uses-the-configured-browser-executable
  (with-redefs [cf/config (assoc cf/config :browser-executable "/runtime/chromium")]
    (let [options (browser/launch-options)]
      (t/is (= "/runtime/chromium" (unchecked-get options "executablePath")))
      (t/is (= ["--allow-insecure-localhost" "--font-render-hinting=none"]
               (js->clj (unchecked-get options "args")))))))
