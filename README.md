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

The plugin creates `/signalk/vX/api/vessels/self/tracks` endpoint that accepts a single bbox parameter in `southwest_lng,southwest_lat,northeast_lng,northeast_lat` format and returns a GeoJSON FeatureCollection with one MultiLineString feature. The track feature has the following properties:
- `name` (human oriented name)
- `starttime` and `endtime` (ISO 8601 strings in Zulu time)

### Try it out

If you want to try this out I suggest you try [InfluxCloud](https://cloud.influxdata.com/) (have not tried yet myself) or run InfluxDb locally with Docker by using [ready made Dockerfiles](https://github.com/tutumcloud/influxdb).

Compatible with InfluxDB 1.x.
