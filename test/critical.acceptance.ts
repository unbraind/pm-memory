import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { consumerFixture, installConsumer, execute } from './consumer-helpers.ts';
import { criticalConsumerSource } from './critical-consumer-source.ts';

test('one packed artifact preserves same-author peers, retains interrupted forward identities and refuses provenance in native Node and Bun consumers', t => {
  const fixture = consumerFixture(t); const consumer = installConsumer(fixture, 'npm');
  writeFileSync(join(consumer, 'critical.ts'), criticalConsumerSource());
  for (const [label, runtime, command, prefix] of [['node', process.execPath, 'npx', ['--no-install', 'pm']], ['bun', 'bun', 'bunx', ['--bun', '--no-install', 'pm']]] as const) {
    assert.match(execute(consumer, ['critical.ts', label], runtime, fixture.env), /exact ownership accepted/);
    const receipt = JSON.parse(readFileSync(join(consumer, 'critical-receipt-' + label + '.json'), 'utf8')) as { workspace: string; input: string };
    const env = { ...fixture.env, PM_PATH: receipt.workspace };
    execute(consumer, [...prefix, 'package', 'install', join(fixture.scratch, fixture.packed[0].filename)], command, env);
    execute(consumer, ['critical.ts', label, 'mark'], runtime, env);
    for (const flags of [[], ['--json']]) {
      const output = execute(consumer, [...prefix, 'memory', 'import', receipt.input, '--from', 'agents-md', ...flags], command, env, 2);
      assert.match(output, /relationship/); assert.match(output, /provenance/); assert.ok(output.length < 4096);
      if (flags.length > 0) assert.equal(JSON.parse(output).code, 'relationship');
      execute(consumer, ['critical.ts', label, 'check'], runtime, env);
    }
  }
  t.diagnostic(`PACKED_CRITICAL native_runtimes=2 same_author_processes=4 retained_forward_items=2 cli_refusals=4 formats=json,toon integrity=${fixture.packed[0].integrity}`);
});
