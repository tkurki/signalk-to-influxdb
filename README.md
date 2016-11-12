# Signal K to InfluxDb Plugin
Signal K Node server plugin to write all simple numeric Signal K values to [InfluxDB](https://www.influxdata.com/time-series-platform/influxdb/), a time series database.

Once the data is in InfluxDb you can use for example [Grafana](http://grafana.org/) to draw pretty graphs of your data.

The plugin assumes that the database you specify exists. You can create one with

`curl -X POST http://localhost:8086/query?q=CREATE+DATABASE+boatdata`

The plugin writes only `self` data. It converts Signal K paths to InfluxDb `measurement` keys in CamelCase format, eg. `navigationPosition`.

Adding support for non-self data would be pretty easy by adding context as InfluxDB tags.

If you want to try this out I suggest you try [InfluxCloud](https://cloud.influxdata.com/) (have not tried yet myself) or run InfluxDb locally with Docker by using [ready made Dockerfiles](https://github.com/tutumcloud/influxdb).

Compatible with InfluxDB 1.x.
