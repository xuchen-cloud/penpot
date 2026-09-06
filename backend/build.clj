(ns build
  (:refer-clojure :exclude [compile])
  (:require
   [clojure.java.io :as io]
   [clojure.tools.build.api :as b])
  (:import
   (java.nio.file CopyOption Files StandardCopyOption)
   (java.util.zip Deflater ZipEntry ZipFile ZipOutputStream)))

(def class-dir "target/classes")
(def basis (b/create-basis {:project "deps.edn"}))
(def jar-file "target/penpot.jar")

(defn- normalize-jar-timestamps! [path]
  (let [epoch-seconds (Long/parseLong (or (System/getenv "SOURCE_DATE_EPOCH") "315532800"))
        epoch-millis  (* epoch-seconds 1000)
        temporary    (str path ".normalized")]
    (with-open [archive (ZipFile. path)
                output  (ZipOutputStream. (io/output-stream temporary))]
      (.setLevel output Deflater/BEST_COMPRESSION)
      (doseq [entry (enumeration-seq (.entries archive))]
        (let [normalized (doto (ZipEntry. (.getName entry))
                           (.setMethod (.getMethod entry))
                           (.setTime epoch-millis))]
          (when (= ZipEntry/STORED (.getMethod entry))
            (.setSize normalized (.getSize entry))
            (.setCompressedSize normalized (.getSize entry))
            (.setCrc normalized (.getCrc entry)))
          (.putNextEntry output normalized)
          (when-not (.isDirectory entry)
            (with-open [input (.getInputStream archive entry)]
              (io/copy input output)))
          (.closeEntry output))))
    (Files/move (.toPath (io/file temporary))
                (.toPath (io/file path))
                (into-array CopyOption [StandardCopyOption/REPLACE_EXISTING]))))

(defn clean [_]
  (b/delete {:path "target"}))

(defn jar [_]
  (b/copy-dir
   {:src-dirs ["src" "resources"]
    :target-dir class-dir})

  (b/uber
   {:class-dir class-dir
    :uber-file jar-file
    :main 'clojure.main
    :exclude [#".*Log4j2Plugins\.dat$"]
    :basis basis})
  (normalize-jar-timestamps! jar-file))

(defn compile [_]
  (b/javac
   {:src-dirs ["dev/java"]
    :class-dir class-dir
    :basis basis
    :javac-opts ["-source" "17" "-target" "17"]}))
