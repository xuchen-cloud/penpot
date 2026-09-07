;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.storage-tmp-test
  (:require
   [app.storage.tmp :as tmp]
   [clojure.test :as t]
   [datoteka.fs :as fs])
  (:import
   java.nio.file.Files
   java.nio.file.LinkOption
   java.nio.file.attribute.FileAttribute))

(t/deftest creates-tempfiles-without-posix-permissions-on-windows
  (let [directory (Files/createTempDirectory
                   "penpot-storage-tmp-test-"
                   (make-array FileAttribute 0))]
    (try
      (let [path (binding [fs/*system* :dos]
                   (tmp/tempfile* :dir (str directory)))]
        (try
          (t/is (Files/isRegularFile path (make-array LinkOption 0)))
          (finally
            (Files/deleteIfExists path))))
      (finally
        (Files/deleteIfExists directory)))))
