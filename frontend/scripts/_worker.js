import proc from "node:child_process";
import fs from "node:fs/promises";
import ph from "node:path";
import url from "node:url";
import * as sass from "sass-embedded";
import log from "fancy-log";

import wpool from "workerpool";
import postcss from "postcss";
import modulesProcessor from "postcss-modules";
import autoprefixerProcessor from "autoprefixer";

import { generateScopedName } from "./_css-modules.js";

const compiler = await sass.initAsyncCompiler();

async function compileFile(path) {
  const dir = ph.dirname(path);
  const name = ph.basename(path, ".scss");
  const dest = `${dir}${ph.sep}${name}.css`;

  return new Promise(async (resolve, reject) => {
    try {
      const result = await compiler.compileAsync(path, {
        loadPaths: [
          "node_modules/animate.css",
          "resources/styles/common/",
          "resources/styles",
          "src/app/main/ui/",
        ],
        sourceMap: false,
      });
      resolve({
        inputPath: path,
        outputPath: dest,
        css: result.css,
      });
    } catch (cause) {
      reject(cause);
    }
  });
}

function configureModulesProcessor(options) {
  return modulesProcessor({
    getJSON: (cssFileName, json, outputFileName) => {
      // We do nothing because we don't want the generated JSON files
    },
    // Calculates the whole css-module selector name.
    // Should be the same as the one in the file `/src/app/main/style.clj`
    generateScopedName,
  });
}

function configureProcessor(options = {}) {
  const processors = [];

  if (options.modules) {
    processors.push(configureModulesProcessor(options));
  }
  processors.push(autoprefixerProcessor);

  return postcss(processors);
}

async function postProcessFile(data, options) {
  const proc = configureProcessor(options);

  // We compile to the same path (all in memory)
  const result = await proc.process(data.css, {
    from: data.outputPath,
    to: data.outputPath,
    map: false,
  });

  return Object.assign(data, {
    css: result.css,
  });
}

async function compile(path, options) {
  let result = await compileFile(path);
  return await postProcessFile(result, options);
}

wpool.worker(
  {
    compileSass: compile,
  },
  {
    onTerminate: async (code) => {
      // log.info("worker: terminate");
      await compiler.dispose();
    },
  },
);
