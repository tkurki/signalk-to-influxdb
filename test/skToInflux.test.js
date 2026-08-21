// Tests for deltaToPointsConverter, focusing on deltas that carry null values.
// A source that loses its fix (or is otherwise unavailable) sends
// `{path: 'navigation.position', value: null}`, which used to throw
// "Cannot read properties of null (reading 'longitude')" in the delta handler.
//
// Run with:  npm run build && npm test
const test = require('node:test')
const assert = require('node:assert/strict')
const { deltaToPointsConverter } = require('../built/skToInflux')

const SELF_CONTEXT = 'vessels.urn:mrn:imo:mmsi:230099999'

// Each test uses its own context, since the converter keeps module level
// per-context timestamps of what was last stored.
function makeDelta(context, values, timestamp = '2026-08-20T17:00:47.000Z') {
  return {
    context,
    updates: [
      {
        $source: 'test.source',
        timestamp,
        values
      }
    ]
  }
}

function makeConverter() {
  return deltaToPointsConverter(
    SELF_CONTEXT,
    true, // recordTrack
    true, // separateLatLon
    () => true, // shouldStore
    0, // resolution
    true // storeOthers
  )
}

test('a null position value is skipped instead of throwing', () => {
  const converter = makeConverter()
  const points = converter(
    makeDelta('vessels.null-position', [
      { path: 'navigation.position', value: null }
    ])
  )
  assert.deepEqual(points, [])
})

test('a position without numeric latitude/longitude is skipped', () => {
  const converter = makeConverter()
  const points = converter(
    makeDelta('vessels.partial-position', [
      { path: 'navigation.position', value: { longitude: 25.1 } }
    ])
  )
  assert.deepEqual(points, [])
})

test('a valid position is still stored after a null one', () => {
  const converter = makeConverter()
  const context = 'vessels.recovering-position'
  converter(
    makeDelta(context, [{ path: 'navigation.position', value: null }])
  )
  const points = converter(
    makeDelta(context, [
      { path: 'navigation.position', value: { latitude: 60.1, longitude: 25.1 } }
    ])
  )
  assert.equal(points.length, 2)
  assert.equal(points[0].measurement, 'navigation.position')
  assert.equal(
    points[0].fields.jsonValue,
    JSON.stringify({ longitude: 25.1, latitude: 60.1 })
  )
  assert.equal(points[1].fields.lat, 60.1)
  assert.equal(points[1].fields.lon, 25.1)
})

test('a null attitude value is skipped instead of throwing', () => {
  const converter = makeConverter()
  const points = converter(
    makeDelta('vessels.null-attitude', [
      { path: 'navigation.attitude', value: null }
    ])
  )
  assert.deepEqual(points, [])
})

test('a null value for the empty path is skipped instead of throwing', () => {
  const converter = makeConverter()
  const points = converter(
    makeDelta('vessels.null-emptypath', [{ path: '', value: null }])
  )
  assert.deepEqual(points, [])
})

test('a null entry in values is skipped instead of throwing', () => {
  const converter = makeConverter()
  const points = converter(
    makeDelta('vessels.null-pathvalue', [
      null,
      { path: 'navigation.speedOverGround', value: 3.4 }
    ])
  )
  assert.equal(points.length, 1)
  assert.equal(points[0].measurement, 'navigation.speedOverGround')
  assert.equal(points[0].fields.value, 3.4)
})

test('other null values are still stored as jsonValue', () => {
  const converter = makeConverter()
  const points = converter(
    makeDelta('vessels.null-value', [
      { path: 'environment.depth.belowTransducer', value: null }
    ])
  )
  assert.equal(points.length, 1)
  assert.equal(points[0].fields.jsonValue, 'null')
})
