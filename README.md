# Signal K to InfluxDb Plugin
Signal K Node server plugin to write all simple numeric Signal K values to [InfluxDB](https://www.influxdata.com/time-series-platform/influxdb/), a time series database.

Once the data is in InfluxDb you can use for example [Grafana](http://grafana.org/) to draw pretty graphs of your data.

The plugin assumes that the database you specify exists. You can create one with

`curl -X POST http://localhost:8086/query?q=CREATE+DATABASE+boatdata`

The plugin writes only `self` data. It converts Signal K paths to InfluxDb `measurement` keys in CamelCase format, eg. `navigationPosition`.

Adding support for non-self data would be pretty easy by adding context as InfluxDB tags.

### Position handling and tracks

If enabled by black/whitelist configuration `navigation.position` updates are written to the db no more frequently than once per second. More frequent updates are simply ignored.

The coordinates are written as `[lon, lat]` strings for minimal postprocessing in GeoJSON conversion.

The plugin creates `/signalk/vX/api/self/track` endpoint that accepts two parameters:
- timespan in the xxxY format, where xxx is a Number and Y one of 
  - s  (seconds)
  - m  (minutes)
  - h  (hours)
  - d  (days)
  - w  (weeks)
- resolution in the same format
and returns GeoJSON MultiLineString. For example `http://localhost:3000/signalk/v1/api/self/track?timespan=1d&resolution=1h` will return the data for the last 1 day (24 hours) with one position per hour. The data is simply sampled with InfluxDB's `first()` function.

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

### Try it out

You can start a local InfluxDb & Grafana with `docker-compose up` and then configure the plugin to write to
localhost:8086 and then configure [Grafana](http://localhost:3001/) to use InfluxDb data. 