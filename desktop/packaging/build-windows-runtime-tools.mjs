import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { desktopRoot } from "./verify.mjs";
import { defaultPreparedRoot, WINDOWS_TARGET } from "./windows-runtime.mjs";

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function run(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status ?? result.signal})`);
}

async function required(path, label) {
  if (!(await exists(path))) throw new Error(`${label} is missing: ${path}`);
  return path;
}

async function replaceDirectory(destination, build) {
  const staging = `${destination}.staging-${process.pid}`;
  const replaced = `${destination}.replaced-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await build(staging);
    if (await exists(destination)) await rename(destination, replaced);
    await rename(staging, destination);
    await rm(replaced, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if ((await exists(replaced)) && !(await exists(destination))) await rename(replaced, destination);
    throw error;
  }
}

function visualStudioInstall() {
  const vswhere = join(process.env["ProgramFiles(x86)"], "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const result = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("Visual Studio C++ build tools are required");
  return result.stdout.trim();
}

function runDeveloperCommand(vsInstall, command, cwd) {
  const dev = join(vsInstall, "Common7", "Tools", "VsDevCmd.bat");
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/c", `call "${dev}" -no_logo -arch=x64 -host_arch=x64 && ${command}`],
    { cwd, env: process.env, stdio: "inherit", windowsVerbatimArguments: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cmd.exe failed (${result.status ?? result.signal})`);
}

async function copyVisualCppRuntime(
  vsInstall,
  output,
  files = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"],
  component = "Microsoft.VC143.CRT",
) {
  const redistRoot = join(vsInstall, "VC", "Redist", "MSVC");
  const versions = (await readdir(redistRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    const crtRoot = join(redistRoot, version, "x64", component);
    if (await Promise.all(files.map((file) => exists(join(crtRoot, file)))).then((values) => values.every(Boolean))) {
      for (const file of files) await cp(join(crtRoot, file), join(output, file));
      return;
    }
  }
  throw new Error("Visual C++ x64 runtime DLLs are required to run the bundled Garnet native dependencies");
}

export async function buildWindowsRuntimeTools(preparedRoot = defaultPreparedRoot(desktopRoot)) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows tool builds require a Windows x64 host");

  const dotnet = await required(join(preparedRoot, "dotnet-sdk", "dotnet.exe"), ".NET SDK");
  const garnetSource = await required(join(preparedRoot, "garnet-source", "main", "GarnetServer", "GarnetServer.csproj"), "Garnet source");
  await replaceDirectory(join(preparedRoot, "garnet"), async (output) => {
    const dotnetHome = join(desktopRoot, ".cache", "dotnet-home");
    await mkdir(join(dotnetHome, "Roaming", "NuGet"), { recursive: true });
    await mkdir(join(dotnetHome, "Local"), { recursive: true });
    const dotnetEnv = {
      ...process.env,
      APPDATA: join(dotnetHome, "Roaming"),
      DOTNET_CLI_HOME: dotnetHome,
      LOCALAPPDATA: join(dotnetHome, "Local"),
      NUGET_HTTP_CACHE_PATH: join(desktopRoot, ".cache", "nuget-http"),
      NUGET_PACKAGES: join(desktopRoot, ".cache", "nuget-packages"),
    };
    run(dotnet, ["restore", garnetSource, "--configfile", join(desktopRoot, "packaging", "nuget.windows.config"), "-r", "win-x64", "-p:TargetFramework=net8.0"], dirname(garnetSource), dotnetEnv);
    run(dotnet, ["publish", garnetSource, "-c", "Release", "-f", "net8.0", "-r", "win-x64", "--self-contained", "true", "--no-restore", "-p:PublishReadyToRun=false", "-p:EnableSourceLink=false", "-p:EnableSourceControlManagerQueries=false", "-o", output], dirname(garnetSource), dotnetEnv);
    await cp(join(preparedRoot, "garnet-source", "LICENSE"), join(output, "LICENSE"));
    for (const file of ["GarnetServer.exe", "coreclr.dll", "hostfxr.dll", "hostpolicy.dll"]) await required(join(output, file), "self-contained Garnet output");
  });

  const vsInstall = visualStudioInstall();
  await copyVisualCppRuntime(vsInstall, join(preparedRoot, "garnet"));
  await copyVisualCppRuntime(vsInstall, join(preparedRoot, "imagemagick"), ["vcomp140.dll"], "Microsoft.VC143.OpenMP");
  const zlib = await required(join(preparedRoot, "zlib-source", "win32", "Makefile.msc"), "zlib source");
  runDeveloperCommand(vsInstall, "nmake /f win32\\Makefile.msc clean zlib.lib LOC=-MT", dirname(dirname(zlib)));
  const woffSource = await required(join(preparedRoot, "woff-source", "sfnt2woff.c"), "WOFF source");
  await replaceDirectory(join(preparedRoot, "woff"), async (output) => {
    const sourceRoot = dirname(woffSource);
    const zlibRoot = join(preparedRoot, "zlib-source");
    const compatibilityRoot = join(desktopRoot, "packaging", "windows-compat", "woff-tools");
    for (const tool of ["sfnt2woff", "woff2sfnt"]) {
      runDeveloperCommand(vsInstall, `cl /nologo /O2 /MT /DWIN32 /I "${compatibilityRoot}" /I "${zlibRoot}" "${join(sourceRoot, `${tool}.c`)}" "${join(sourceRoot, "woff.c")}" "${join(compatibilityRoot, "getopt.c")}" /link /OUT:"${join(output, `${tool}.exe`)}" "${join(zlibRoot, "zlib.lib")}"`, sourceRoot);
      await required(join(output, `${tool}.exe`), `${tool} output`);
    }
    await cp(join(sourceRoot, "LICENSE"), join(output, "LICENSE.woff-tools"));
    await cp(join(zlibRoot, "LICENSE"), join(output, "LICENSE.zlib"));
  });

  const woff2Source = await required(join(preparedRoot, "woff2-source", "CMakeLists.txt"), "WOFF2 source");
  const brotliSource = await required(join(preparedRoot, "brotli-source", "CMakeLists.txt"), "Brotli source");
  const cmake = await required(join(vsInstall, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe"), "Visual Studio CMake");
  await replaceDirectory(join(preparedRoot, "woff2"), async (output) => {
    const brotliBuild = join(desktopRoot, ".cache", "brotli-build", WINDOWS_TARGET);
    const brotliInstall = join(desktopRoot, ".cache", "brotli-install", WINDOWS_TARGET);
    const build = join(desktopRoot, ".cache", "woff2-build", WINDOWS_TARGET);
    await rm(brotliBuild, { recursive: true, force: true });
    await rm(brotliInstall, { recursive: true, force: true });
    await rm(build, { recursive: true, force: true });
    run(cmake, ["-S", dirname(brotliSource), "-B", brotliBuild, "-G", "Visual Studio 17 2022", "-A", "x64", `-DCMAKE_INSTALL_PREFIX=${brotliInstall}`, "-DBUILD_SHARED_LIBS=OFF", "-DBROTLI_BUILD_TOOLS=OFF", "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"], desktopRoot);
    run(cmake, ["--build", brotliBuild, "--config", "Release", "--target", "install"], desktopRoot);
    const brotliLibraryRoot = join(brotliInstall, "lib");
    run(cmake, ["-S", dirname(woff2Source), "-B", build, "-G", "Visual Studio 17 2022", "-A", "x64", `-DCMAKE_PREFIX_PATH=${brotliInstall}`, `-DBROTLIDEC_LIBRARIES=${join(brotliLibraryRoot, "brotlidec-static.lib")};${join(brotliLibraryRoot, "brotlicommon-static.lib")}`, `-DBROTLIENC_LIBRARIES=${join(brotliLibraryRoot, "brotlienc-static.lib")};${join(brotliLibraryRoot, "brotlicommon-static.lib")}`, "-DBUILD_SHARED_LIBS=OFF", "-DCANONICAL_PREFIXES=ON", "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"], desktopRoot);
    run(cmake, ["--build", build, "--config", "Release", "--target", "woff2_decompress"], desktopRoot);
    const executable = join(build, "Release", "woff2_decompress.exe");
    await required(executable, "woff2_decompress output");
    await cp(executable, join(output, "woff2_decompress.exe"));
    await cp(join(dirname(woff2Source), "LICENSE"), join(output, "LICENSE.woff2"));
    await cp(join(dirname(brotliSource), "LICENSE"), join(output, "LICENSE.brotli"));
  });
}

if (process.argv[1]?.endsWith("build-windows-runtime-tools.mjs")) {
  buildWindowsRuntimeTools().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
