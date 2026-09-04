import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const [, , action, ...args] = process.argv;

async function main() {
  switch (action) {
    case "chromium":
      return checkChromium(...args);
    case "font":
      return checkFont(...args);
    case "export":
      return checkExport(...args);
    default:
      throw new Error(`unknown check ${JSON.stringify(action)}`);
  }
}

async function checkChromium(executable, outputPath) {
  requireArguments("chromium", [executable, outputPath]);
  const output = await run(executable, [
    "--headless",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    "--no-first-run",
    "--no-sandbox",
    "--dump-dom",
    "data:text/html,<title>Penpot offline Chromium</title><p>ready</p>",
  ]);
  if (!output.includes("Penpot offline Chromium") || !output.includes("ready")) {
    throw new Error("Chromium did not render the offline data URL");
  }
  await writeFile(outputPath, output);
}

async function checkFont(baseUrl, sourcePath, sourceType, targetType, outputPath) {
  requireArguments("font", [baseUrl, sourcePath, sourceType, targetType, outputPath]);
  const data = await readFile(sourcePath);
  const form = new FormData();
  form.append("file", new Blob([data], { type: sourceType }), "fixture-font");
  const response = await fetch(
    `${baseUrl}/api/font/convert?target-type=${encodeURIComponent(targetType)}`,
    {
      method: "POST",
      headers: { "x-shared-key": "desktop-compatibility-key" },
      body: form,
    },
  );
  if (!response.ok) {
    throw new Error(`font conversion failed with ${response.status}: ${await response.text()}`);
  }
  const result = Buffer.from(await response.arrayBuffer());
  if (result.length < 4) {
    throw new Error("font conversion returned an empty result");
  }
  await writeFile(outputPath, result);
}

async function checkExport(baseUrl, requestPath, outputPath) {
  requireArguments("export", [baseUrl, requestPath, outputPath]);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const response = await fetch(new URL(request.path ?? "/api/export", baseUrl), {
    method: request.method ?? "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...request.headers,
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  if (!response.ok) {
    throw new Error(`export failed with ${response.status}: ${await response.text()}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return;
  }
  const result = await response.json();
  const artifactUrl = field(result, request.artifactUrlField);
  if (typeof artifactUrl !== "string") {
    throw new Error("export response did not contain the configured artifact URL");
  }
  const artifact = await fetch(new URL(artifactUrl, request.artifactBaseUrl ?? baseUrl), {
    headers: request.artifactHeaders,
  });
  if (!artifact.ok) {
    throw new Error(`export artifact fetch failed with ${artifact.status}: ${await artifact.text()}`);
  }
  await writeFile(outputPath, Buffer.from(await artifact.arrayBuffer()));
}

function field(value, path) {
  if (typeof path !== "string" || path.length === 0) return undefined;
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function requireArguments(name, values) {
  const missing = values.findIndex((value) => value === undefined);
  if (missing !== -1) {
    throw new Error(`${name} is missing argument ${missing + 1}`);
  }
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(
          new Error(
            `process exited with ${code ?? signal}: ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      }
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
