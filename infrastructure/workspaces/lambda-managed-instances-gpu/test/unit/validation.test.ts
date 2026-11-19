import { buildStack, newApp, testParams } from '../helpers/stack';

/** Parameter validation performed by the GPU constructs before synthesis. */
describe('parameter validation', () => {
  const base = testParams();
  const build = (overrides: Parameters<typeof buildStack>[1]) => () => buildStack(newApp(), overrides);

  test.each([
    [['c6i.2xlarge'], /not a supported GPU instance type/],
    [['g6.2xlarge', 'm7i.2xlarge'], /not a supported GPU instance type/],
    [['g4dn.metal'], /g4dn.metal is not supported/],
    [[], /at least one GPU instance type/],
  ])('rejects allowedInstanceTypes %p', (types, error) => {
    expect(build({ capacity: { ...base.capacity, allowedInstanceTypes: types } })).toThrow(error);
  });

  test.each([1, 15001])('rejects maxVCpuCount %p', (maxVCpuCount) => {
    expect(build({ capacity: { ...base.capacity, maxVCpuCount } })).toThrow(/maxVCpuCount must be between 2 and 15000/);
  });

  test('accepts maxVCpuCount below the L2 minimum of 12', () => {
    expect(build({ capacity: { ...base.capacity, maxVCpuCount: 4 } })).not.toThrow();
  });

  test.each([0, 101])('rejects targetGpuUtilization %p', (targetGpuUtilization) => {
    expect(build({ capacity: { ...base.capacity, targetGpuUtilization } })).toThrow(/targetGpuUtilization/);
  });

  test('rejects an AcceleratorMemorySize outside the allowed set', () => {
    expect(
      build({ gpuFunction: { ...base.gpuFunction, acceleratorMemorySizeGiB: 8 as unknown as 16 } }),
    ).toThrow(/acceleratorMemorySizeGiB must be one of 3, 6, 12, 16, 24, 48/);
  });

  test.each([1024, 40960])('rejects memorySizeMiB %p for GPU functions', (memorySizeMiB) => {
    expect(build({ gpuFunction: { ...base.gpuFunction, memorySizeMiB } })).toThrow(/memorySizeMiB must be between 2048 and 32768/);
  });

  test.each([0, 49])('rejects perExecutionEnvironmentMaxConcurrency %p', (perExecutionEnvironmentMaxConcurrency) => {
    expect(build({ gpuFunction: { ...base.gpuFunction, perExecutionEnvironmentMaxConcurrency } })).toThrow(
      /perExecutionEnvironmentMaxConcurrency must be between 1 and 48/,
    );
  });

  test('rejects minExecutionEnvironments greater than maxExecutionEnvironments (L2 validation)', () => {
    expect(
      build({ gpuFunction: { ...base.gpuFunction, minExecutionEnvironments: 2, maxExecutionEnvironments: 1 } }),
    ).toThrow(/minExecutionEnvironments must be less than or equal to maxExecutionEnvironments/);
  });

  test('allows scale-to-zero (min 0)', () => {
    expect(build({ gpuFunction: { ...base.gpuFunction, minExecutionEnvironments: 0 } })).not.toThrow();
  });
});
