const test = require('node:test')
const http = require('node:http')
const assert = require('node:assert')
const Influx = require('influx')
const { escapeMeasurements } = require('../built/skToInflux')

// Captures the line protocol body node-influx POSTs to /write, using a local
// HTTP server so the test doesn't depend on node-influx internals.
async function captureLineProtocol(points) {
  let body
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      if (req.url.startsWith('/write')) body = data
      res.statusCode = 204
      res.end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new Influx.InfluxDB({
      host: '127.0.0.1',
      port: server.address().port,
      database: 'test'
    })
    await client.writePoints(points)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
  return body
}

test('escapeMeasurements escapes spaces and commas in measurement names', async () => {
  const points = [
    {
      measurement: 'providers.Arabella Compass.deltaRate',
      tags: { context: 'vessels.urn:mrn:imo:mmsi:230083470', source: 'signalk-server' },
      fields: { value: 0 },
      timestamp: new Date(1795119704826)
    },
    {
      measurement: 'a,b',
      fields: { value: 1 }
    }
  ]
  const body = await captureLineProtocol(escapeMeasurements(points))
  const lines = body.split('\n')
  assert.strictEqual(
    lines[0],
    'providers.Arabella\\ Compass.deltaRate,context=vessels.urn:mrn:imo:mmsi:230083470,source=signalk-server value=0 1795119704826000000'
  )
  assert.strictEqual(lines[1], 'a\\,b value=1')
  // The original points are not mutated.
  assert.strictEqual(points[0].measurement, 'providers.Arabella Compass.deltaRate')
})

test('escapeMeasurements leaves ordinary paths unchanged', () => {
  const [p] = escapeMeasurements([{ measurement: 'navigation.speedOverGround', fields: { value: 1 } }])
  assert.strictEqual(p.measurement, 'navigation.speedOverGround')
})
