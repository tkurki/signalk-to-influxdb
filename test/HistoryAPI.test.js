// Smoke tests for the InfluxHistoryProvider, using Node's built-in test
// runner. These exercise the provider with a mocked InfluxDB v1 client so they
// need no running database.
//
// Run with:  npm run build && npm test
const test = require('node:test')
const assert = require('node:assert/strict')
const { Temporal } = require('@js-temporal/polyfill')
const { isHistoryProvider } = require('@signalk/server-api/history')
const { InfluxHistoryProvider } = require('../built/HistoryAPI')

const SELF_ID = 'urn:mrn:imo:mmsi:230099999'
const SELF_CONTEXT = `vessels.${SELF_ID}`

// The node `influx` library's query() resolves to an array-like whose elements
// are the individual rows, augmented with a groups() method that returns one
// entry per measurement series ({ name, rows }). This mock reproduces that
// shape so we can exercise the provider without a running database.
function makeMockInflux(queryFn) {
  return Promise.resolve({
    query: (sql) => Promise.resolve(queryFn(sql)),
  })
}

// Builds a numeric InfluxQL result for a single measurement/series, where each
// row carries the aggregated value under the aggregate-function field name
// (e.g. `mean`, `max`). Flat rows and groups() rows share the same data.
function numericResult(name, field, rows) {
  const flat = rows.map((r) => ({ time: r.time, [field]: r.value }))
  const result = flat.slice()
  result.groups = () => [{ name, rows: flat }]
  return result
}

// Builds a position result: navigation.position is stored in v1 as a jsonValue
// JSON string {longitude, latitude}; FIRST(jsonValue) is selected as `value`.
function positionResult(rows) {
  return rows.map((r) => ({
    time: r.time,
    value: JSON.stringify({ longitude: r.lon, latitude: r.lat }),
  }))
}

const noopDebug = () => undefined

test('InfluxHistoryProvider implements the HistoryApi provider contract', () => {
  const provider = new InfluxHistoryProvider(
    makeMockInflux(() => []),
    SELF_ID,
    noopDebug
  )
  assert.equal(isHistoryProvider(provider), true)
  assert.equal(typeof provider.getValues, 'function')
  assert.equal(typeof provider.getContexts, 'function')
  assert.equal(typeof provider.getPaths, 'function')
})

test('getValues resolves vessels.self to the full self context and returns the documented response shape', async () => {
  const influx = makeMockInflux(() =>
    numericResult('navigation.speedOverGround', 'mean', [
      { time: new Date('2026-08-08T00:00:00.000Z'), value: 5.1 },
      { time: new Date('2026-08-08T00:01:00.000Z'), value: 5.4 },
    ])
  )
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const result = await provider.getValues({
    from: Temporal.Instant.from('2026-08-08T00:00:00.000Z'),
    to: Temporal.Instant.from('2026-08-08T00:02:00.000Z'),
    context: 'vessels.self',
    resolution: 60,
    pathSpecs: [
      { path: 'navigation.speedOverGround', aggregate: 'average', parameter: [] },
    ],
  })

  assert.equal(result.context, SELF_CONTEXT)
  assert.deepEqual(result.range, {
    from: '2026-08-08T00:00Z',
    to: '2026-08-08T00:02Z',
  })
  assert.deepEqual(result.values, [
    { path: 'navigation.speedOverGround', method: 'average' },
  ])
  assert.deepEqual(result.data, [
    ['2026-08-08T00:00:00.000Z', 5.1],
    ['2026-08-08T00:01:00.000Z', 5.4],
  ])
})

test('getValues extracts navigation.position from the v1 jsonValue storage into a [lon, lat] pair', async () => {
  const influx = makeMockInflux(() =>
    positionResult([
      { time: new Date('2026-08-08T00:00:00.000Z'), lon: 21.1, lat: 60.2 },
      { time: new Date('2026-08-08T00:01:00.000Z'), lon: 21.2, lat: 60.3 },
    ])
  )
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const result = await provider.getValues({
    from: Temporal.Instant.from('2026-08-08T00:00:00.000Z'),
    to: Temporal.Instant.from('2026-08-08T00:02:00.000Z'),
    context: SELF_CONTEXT,
    resolution: 60,
    pathSpecs: [
      { path: 'navigation.position', aggregate: 'first', parameter: [] },
    ],
  })

  assert.deepEqual(result.values, [
    { path: 'navigation.position', method: 'first' },
  ])
  assert.deepEqual(result.data, [
    ['2026-08-08T00:00:00.000Z', [21.1, 60.2]],
    ['2026-08-08T00:01:00.000Z', [21.2, 60.3]],
  ])
})

test('getValues includes sourceRef only when a source filter was requested, and filters the query by source', async () => {
  let capturedSql = ''
  const influx = makeMockInflux((sql) => {
    capturedSql = sql
    return numericResult('navigation.speedOverGround', 'max', [
      { time: new Date('2026-08-08T00:00:00.000Z'), value: 7 },
    ])
  })
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const result = await provider.getValues({
    from: Temporal.Instant.from('2026-08-08T00:00:00.000Z'),
    to: Temporal.Instant.from('2026-08-08T00:02:00.000Z'),
    context: SELF_CONTEXT,
    resolution: 60,
    pathSpecs: [
      { path: 'navigation.speedOverGround', aggregate: 'max', parameter: [], sourceRef: 'n2k-can0.115' },
    ],
  })

  assert.deepEqual(result.values, [
    { path: 'navigation.speedOverGround', method: 'max', sourceRef: 'n2k-can0.115' },
  ])
  assert.ok(capturedSql.includes("\"source\" = 'n2k-can0.115'"))
})

test('getValues collates position and numeric series by timestamp union, nulling missing sides', async () => {
  // Position has buckets at :00 and :02; numeric at :00 and :01.
  const influx = makeMockInflux((sql) =>
    sql.indexOf('navigation.position') >= 0
      ? positionResult([
          { time: new Date('2026-08-08T00:00:00.000Z'), lon: 21.1, lat: 60.2 },
          { time: new Date('2026-08-08T00:02:00.000Z'), lon: 21.3, lat: 60.4 },
        ])
      : numericResult('navigation.speedOverGround', 'mean', [
          { time: new Date('2026-08-08T00:00:00.000Z'), value: 5.1 },
          { time: new Date('2026-08-08T00:01:00.000Z'), value: 5.4 },
        ])
  )
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const result = await provider.getValues({
    from: Temporal.Instant.from('2026-08-08T00:00:00.000Z'),
    to: Temporal.Instant.from('2026-08-08T00:03:00.000Z'),
    context: SELF_CONTEXT,
    resolution: 60,
    pathSpecs: [
      { path: 'navigation.position', aggregate: 'first', parameter: [] },
      { path: 'navigation.speedOverGround', aggregate: 'average', parameter: [] },
    ],
  })

  assert.deepEqual(
    result.values.map((v) => v.path),
    ['navigation.position', 'navigation.speedOverGround']
  )
  assert.deepEqual(result.data, [
    ['2026-08-08T00:00:00.000Z', [21.1, 60.2], 5.1],
    ['2026-08-08T00:01:00.000Z', null, 5.4],
    ['2026-08-08T00:02:00.000Z', [21.3, 60.4], null],
  ])
})

test('getValues accepts duration as an ISO8601 Temporal.Duration together with `to`', async () => {
  const influx = makeMockInflux(() => numericResult('navigation.speedOverGround', 'mean', []))
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const result = await provider.getValues({
    to: Temporal.Instant.from('2026-08-08T00:15:00.000Z'),
    duration: Temporal.Duration.from('PT15M'),
    context: SELF_CONTEXT,
    resolution: 60,
    pathSpecs: [
      { path: 'navigation.speedOverGround', aggregate: 'average', parameter: [] },
    ],
  })

  assert.deepEqual(result.range, {
    from: '2026-08-08T00:00Z',
    to: '2026-08-08T00:15Z',
  })
})

test('getValues accepts duration as an integer number of seconds relative to now', async () => {
  const influx = makeMockInflux(() => numericResult('navigation.speedOverGround', 'mean', []))
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)
  const before = Date.now()

  const result = await provider.getValues({
    duration: 600, // 10 minutes in seconds
    context: SELF_CONTEXT,
    resolution: 60,
    pathSpecs: [
      { path: 'navigation.speedOverGround', aggregate: 'average', parameter: [] },
    ],
  })

  const toMs = Date.parse(result.range.to)
  const fromMs = Date.parse(result.range.from)
  assert.ok(toMs > before - 5000, 'to should be ~now')
  assert.ok(Math.abs((toMs - fromMs) - 600_000) < 5000, 'from should be ~10 min before to')
})

test('getValues defaults omitted `to` to now', async () => {
  const influx = makeMockInflux(() => numericResult('navigation.speedOverGround', 'mean', []))
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)
  const before = Date.now()

  const result = await provider.getValues({
    from: Temporal.Instant.from('2026-08-08T00:00:00.000Z'),
    context: SELF_CONTEXT,
    resolution: 60,
    pathSpecs: [
      { path: 'navigation.speedOverGround', aggregate: 'average', parameter: [] },
    ],
  })

  assert.ok(Date.parse(result.range.to) > before - 5000)
})

test('getValues computes a simple moving average (sma) over the window and trims to the requested range', async () => {
  // Values 1..6 at 1-second buckets; request from bucket 4 onward.
  const rows = [1, 2, 3, 4, 5, 6].map((v, i) => ({
    time: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)),
    value: v,
  }))
  const influx = makeMockInflux(() =>
    numericResult('environment.water.temperature', 'mean', rows)
  )
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const result = await provider.getValues({
    from: Temporal.Instant.from('2026-01-01T00:00:04Z'),
    to: Temporal.Instant.from('2026-01-01T00:00:06Z'),
    context: SELF_CONTEXT,
    resolution: 1,
    pathSpecs: [
      { path: 'environment.water.temperature', aggregate: 'sma', parameter: ['3'] },
    ],
  })

  // SMA(3) at bucket 4 = mean(2,3,4) = 3; at 5 = mean(3,4,5)=4; at 6 = mean(4,5,6)=5
  assert.deepEqual(result.values, [
    { path: 'environment.water.temperature', method: 'sma' },
  ])
  assert.deepEqual(
    result.data.map((r) => r[1]),
    [3, 4, 5]
  )
  // The pre-range buckets used to seed the average must be trimmed away.
  assert.equal(result.data.length, 3)
  assert.equal(result.data[0][0], '2026-01-01T00:00:04.000Z')
})

test('getValues computes an exponential moving average (ema) seeded from an initial SMA', async () => {
  // Values 1..30 at 1-second buckets; request from bucket 20 onward.
  const rows = Array.from({ length: 30 }, (_, i) => ({
    time: new Date(Date.UTC(2024, 0, 1, 12, 0, i + 1)),
    value: i + 1,
  }))
  const influx = makeMockInflux(() =>
    numericResult('environment.wind.speedApparent', 'mean', rows)
  )
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const result = await provider.getValues({
    from: Temporal.Instant.from('2024-01-01T12:00:20Z'),
    to: Temporal.Instant.from('2024-01-01T12:00:30Z'),
    context: SELF_CONTEXT,
    resolution: 1,
    pathSpecs: [
      { path: 'environment.wind.speedApparent', aggregate: 'ema', parameter: ['5'] },
    ],
  })

  assert.ok(result.data.length > 0)
  const first = result.data[0][1]
  const last = result.data[result.data.length - 1][1]
  // EMA lags behind the actual rising series (values 20..30).
  assert.ok(first > 15)
  assert.ok(last > first)
  assert.ok(last < 30)
})

test('getContexts returns the list of context tag values', async () => {
  const influx = makeMockInflux(() => [
    { value: 'vessels.urn:mrn:imo:mmsi:230099999' },
    { value: 'vessels.urn:mrn:imo:mmsi:230000001' },
  ])
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const contexts = await provider.getContexts({
    from: Temporal.Instant.from('2026-01-01T00:00:00Z'),
  })

  assert.deepEqual(contexts, [
    'vessels.urn:mrn:imo:mmsi:230099999',
    'vessels.urn:mrn:imo:mmsi:230000001',
  ])
})

test('getPaths returns the list of measurements', async () => {
  const influx = makeMockInflux(() => [
    { name: 'navigation.speedOverGround' },
    { name: 'environment.wind.speedTrue' },
  ])
  const provider = new InfluxHistoryProvider(influx, SELF_ID, noopDebug)

  const paths = await provider.getPaths({
    from: Temporal.Instant.from('2026-01-01T00:00:00Z'),
  })

  assert.deepEqual(paths, [
    'navigation.speedOverGround',
    'environment.wind.speedTrue',
  ])
})
