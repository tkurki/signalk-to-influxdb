# Signal K to InfluxDb Plugin
Signal K Node server plugin to write all simple numeric Signal K values to [InfluxDB 1.x](https://docs.influxdata.com/influxdb/v1.8/), a time series database.

Once the data is in InfluxDb you can use for example [Grafana](http://grafana.org/) to draw pretty graphs of your data.

The plugin assumes that the database you specify exists. You can create one with

`curl -X POST http://localhost:8086/query?q=CREATE+DATABASE+boatdata`

The plugin writes only `self` data. It converts Signal K paths to InfluxDb `measurement` keys in CamelCase format, eg. `navigationPosition`.

Adding support for non-self data would be pretty easy by adding context as InfluxDB tags.

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


### Time Series API

This plugin implements an HTTP API for retrieving historical / time series values with urls like http://localhost:3000/signalk/v1/history/values?from=2021-05-25T20:00:00.001Z&to=2021-05-25T23:00:00.561Z&paths=navigation.speedOverGround,navigation.speedOverGround

- `from` and `to` are date-times with a time offset and/or a time zone in the ISO-8601 calendar system
- `paths` is a comma delimited list of Signal K paths
- `resolution`
- `context`

Additionally you can retrieve the contexts that the db has data for with query like 
http://localhost:3000/signalk/v1/history/contexts?from=2021-05-25T20:00:00.001Z&to=2021-05-25T23:00:00.561Z and paths with 
http://localhost:3000/signalk/v1/history/paths?from=2021-05-25T20:00:00.001Z&to=2021-05-25T23:00:00.561Z

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
