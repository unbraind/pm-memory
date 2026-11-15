import { devNull } from 'node:os';

/** Copy an environment without Git overrides, including Windows spelling variants. */
export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
}

/** Remove all npm policy/config variants before setting one isolated user config. */
export function npmEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_(allow_scripts|userconfig)$/i.test(key))), npm_config_userconfig: devNull };
}

/** Clear inherited test-runner context and disable background telemetry without losing coverage. */
export function testEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^NODE_TEST_CONTEXT$/i.test(key))), PM_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', PM_TELEMETRY_OTEL_DISABLED: '1' };
}
