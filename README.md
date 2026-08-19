# Signal K to InfluxDb Plugin
Signal K Node server plugin to write all simple numeric Signal K values to [InfluxDB 1.x](https://docs.influxdata.com/influxdb/v1.8/), a time series database.

**Note:** If you're interested in using InfluxDB 2.x, see the [signalk-to-influxdb2](https://github.com/tkurki/signalk-to-influxdb2) repository instead. This is the preferred approach for new installations.

Once the data is in InfluxDb you can use for example [Grafana](http://grafana.org/) to draw pretty graphs of your data.

The plugin assumes that the database you specify exists. You can create one with

`curl -X POST http://localhost:8086/query?q=CREATE+DATABASE+boatdata`

The plugin writes only `self` data. Each Signal K path is stored as its own InfluxDb measurement under the raw path name, eg. `navigation.speedOverGround`, so it can be queried directly by the History API. Adding support for non-self data would be pretty easy by adding context as InfluxDB tags.

### Position handling and tracks

If enabled by black/whitelist configuration `navigation.position` updates are written to the db no more frequently than once per second. More frequent updates are simply ignored.

The coordinates are written as `[lon, lat]` strings for minimal postprocessing in GeoJSON conversion.
Optionally, coordinates can be written separately to database. This enable location data to be used in various ways e.g. in Grafana (mapping, functions, ...).

The plugin creates `/signalk/vX/api/self/track` endpoint that accepts three parameters and returns GeoJSON MultiLineString. 

_Parameters:_
- __timespan__: in the format xxxY _(e.g. 1h)_, where xxx is a Number and Y one of:
  - s  (seconds)
  - m  (minutes)
  - h  (hours)
  - d  (days)
  - w  (weeks)

- __resolution__: (in the same format)
specifies the time interval between each point returned.
For example `http://localhost:3000/signalk/v1/api/self/track?timespan=1d&resolution=1h` will return the data for the last 1 day (24 hours) with one position per hour. The data is simply sampled with InfluxDB's `first()` function.

- __timespanOffset__: (number) 
Without timespanOffset defined the end time of the returned data is the current time. Supplying a _timespanOffset_ value changes the end time to be `current time - timespanOffset`. The _timespanOffset_ value is considered to have the same "Y" as  _timespan_.

_Examples: where current time is 14:00_

`http://localhost:3000/signalk/v1/api/self/track?timespan=12h&resolution=1m` returns data in the time window _2:00 - 14:00_

`http://localhost:3000/signalk/v1/api/self/track?timespan=12h&resolution=1m&timespanOffset=1` returns data in the time window _1:00 - 13:00_.

### Sources

If you have multiple sources generating the same data / same Signal K paths you can distinguish between them by specifying `source` in the query:

<img width="635" alt="image" src="https://user-images.githubusercontent.com/1049678/174805296-f15929be-b215-401a-8a95-d45b8c20fdb9.png">

To get persistent source data in data from NMEA 2000 networks use `Use Can NAME in source data` in connection settings. This way all sources will get a unique identity that does not change the NMEA 2000 bus addresses change.

### History API

This plugin implements the Signal K [History API](https://signalk.org/specification/2.0.0/doc/history.html) as a history provider, so the server serves the standard endpoints under `/signalk/v2/api/history/*`:

- `GET /signalk/v2/api/history/values` — retrieve historical data series
- `GET /signalk/v2/api/history/contexts` — contexts that have data
- `GET /signalk/v2/api/history/paths` — paths that have data
- `GET /signalk/v2/api/history/_providers` — registered providers

Example:

```
GET /signalk/v2/api/history/values?from=2026-08-07T04:53:55Z&duration=PT24H&paths=navigation.speedOverGround:average,navigation.position&resolution=60
```

a few more:

```
# last 15 minutes (duration relative to now), max speed per 1-minute bucket
GET /signalk/v2/api/history/values?duration=PT15M&paths=navigation.speedOverGround:max&resolution=1m

# simple moving average over 5 samples, filtered to one source
GET /signalk/v2/api/history/values?from=2026-08-08T00:00:00Z&to=2026-08-08T06:00:00Z&paths=navigation.speedOverGround:sma:5|n2k-on-ve.can0.115

# which contexts / paths have data in the range
GET /signalk/v2/api/history/contexts?from=2026-08-01T00:00:00Z&to=2026-08-08T00:00:00Z
GET /signalk/v2/api/history/paths?duration=P7D

# list registered history providers
GET /signalk/v2/api/history/_providers
```

The `/values` response shape (timestamps first, then one value per requested path; `null` where a path has no data in that bucket):

```json
{
  "context": "vessels.urn:mrn:imo:mmsi:230099999",
  "range": { "from": "2026-08-07T04:53:55Z", "to": "2026-08-08T04:53:55Z" },
  "values": [
    { "path": "navigation.speedOverGround", "method": "average" },
    { "path": "navigation.position", "method": "first" }
  ],
  "data": [
    ["2026-08-07T04:53:55.000Z", 5.4, [21.1, 60.2]],
    ["2026-08-07T04:54:55.000Z", null, [21.2, 60.3]]
  ]
}
```

Query parameters for `/values`:

- **paths** (required): comma separated list of Signal K paths, with an optional aggregation method as a postfix separated by a colon, and an optional source reference separated by a pipe (`|`). Aggregation methods: `average` | `min` | `max` | `first` | `last` | `sma` | `ema`. `sma` accepts the number of samples and `ema` the alpha value (0–1) as a further colon-separated parameter, e.g. `navigation.speedOverGround:sma:5` or `navigation.speedOverGround:ema:0.2|n2k-on-ve.can0.115`.
- **from** / **to**: start and end of the time range as ISO 8601 timestamps (inclusive). Omitted `to` defaults to now.
- **duration**: length of the time range as an integer number of seconds or an ISO 8601 duration string (`PT15M`). Can be combined with either `from` or `to`; when given alone it is relative to now.
- **resolution**: sample window as seconds or a time expression (`1s`, `1m`, `1h`, `1d`). Defaults to a sensible value for the range.
- **context**: Signal K context, defaults to `vessels.self`.
- **provider**: direct the request to a specific history provider plugin.

### Provider

If you want to import log files to InfluxDb this plugin provides also a provider interface that you can
include in your input pipeline. First configure your log playback, then stop the server and insert the following entry in your settings.json:

```
        {
          "type": "signalk-to-influxdb/provider",
          "options": {
            "host": "localhost",
            "port": 8086,
            "database": "signalk",
            "selfId": <your self id here>,
            "batchSize": 1000
          }
        }
```

### Try it out / Development setup

A quick way to get started / try things out / set things up for development is to start InfluxDb and Grafana with`docker-compose up`. Then you need to configure the plugin to write to localhost:8086 and [Grafana](http://localhost:3001/) to use InfluxDb data.

For a real world setup you probably want to install these locally, see for example [Seabits step by step instructions](https://seabits.com/set-up-signal-k-and-grafana-on-raspberry-pi-with-pican-m-nmea-2000-board/).
