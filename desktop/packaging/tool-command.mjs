function requiredString(value, label) {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function resolveToolCommand({ env = process.env, name, fallback }) {
  const commandName = requiredString(name, "Tool command name");
  const configured = env[`${commandName}_COMMAND`];
  if (configured) {
    let values;
    try {
      values = JSON.parse(configured);
    } catch {
      throw new Error(`${commandName}_COMMAND must be a JSON array`);
    }
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`${commandName}_COMMAND must be a non-empty JSON array`);
    }
    return values.map((value, index) =>
      requiredString(value, `${commandName}_COMMAND item ${index}`),
    );
  }
  if (env[commandName]) return [requiredString(env[commandName], commandName)];
  if (Array.isArray(fallback)) {
    if (fallback.length === 0)
      throw new Error(`${commandName} fallback is empty`);
    return fallback.map((value, index) =>
      requiredString(value, `${commandName} fallback item ${index}`),
    );
  }
  return [requiredString(fallback, commandName)];
}

export function invokeTool(run, command, args, cwd, env) {
  if (!Array.isArray(command) || command.length === 0)
    throw new Error("Tool command is empty");
  return run(command[0], [...command.slice(1), ...args], cwd, env);
}

export function encodePowerShellFileArguments(args) {
  if (!Array.isArray(args))
    throw new Error("PowerShell arguments must be an array");
  return args.map((value, index) => {
    const argument = requiredString(value, `PowerShell argument ${index}`);
    return `PENPOT_BASE64:${Buffer.from(argument, "utf8").toString("base64")}`;
  });
}
