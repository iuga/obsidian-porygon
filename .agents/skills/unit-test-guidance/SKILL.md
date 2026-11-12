---
name: unit-test-guidance
description: Use when writing, moving, or reviewing unit tests in a TypeScript repo. Sets test location, filename, suite structure, scope, and the per-test docstring.
---

# TS unit test organization

- **Location**: test files live only under `test/`.
- **Filename**: names the unit and behavior under test (`tool-call-targets.test.ts`), never `utils.test.ts` or `test1.test.ts`.
- **Suites**: every test sits inside a `describe(...)` block, one suite per unit under test.
- **Scope**: cover the most critical use cases only: core behavior, main failure mode, key contract. Each test earns its maintenance cost; exotic edge cases stay out.
- **Docstring**: every test carries a JSDoc block with three parts, in order: the use case, the expectation, and why it matters. The *why* lets a reviewer judge whether the test still earns its place.

## Example

Without a suite or docstring, the title restates the assertion and the reader cannot tell why it matters:

```ts
void test("save_memory uses the shared memory key, not the structural lock", () => {
  assert.deepEqual(getToolCallTargets(lookup, "save_memory", { memory: [] }), {
    exclusive: false,
    keys: [MEMORY_TARGET_KEY],
  });
});
```

Suite plus docstring:

```ts
void describe("getToolCallTargets", () => {
  /**
   * Verifies that `save_memory` uses the shared memory target key instead of
   * the structural lock.
   *
   * The expectation is that the operation is non-exclusive and targets
   * `MEMORY_TARGET_KEY`.
   *
   * This is important to ensure that memory operations coordinate through
   * the shared memory key without unnecessarily blocking unrelated operations
   * that require the structural lock.
   */
  void test("save_memory uses the shared memory key, not the structural lock", () => {
    assert.deepEqual(getToolCallTargets(lookup, "save_memory", { memory: [] }), {
      exclusive: false,
      keys: [MEMORY_TARGET_KEY],
    });
  });
});
```

