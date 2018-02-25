/*
 * Copyright 2018 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const Transform = require('stream').Transform

const Influx = require('influx')
const debug = require('debug')('signalk-to-influxdb')

const skToInflux = require('./skToInflux')

function InfluxWriter (options) {
  Transform.call(this, {
    objectMode: true
  })
  this.options = options
  this.influxP = skToInflux.influxClientP(options)
  this.batchSize = options.batchSize || 1000
  this.points = []
  this.deltaToPoints = skToInflux.deltaToPointsConverter(
    'vessels.' + options.selfId,
    false,
    () => true,
    true
  )
}

require('util').inherits(InfluxWriter, Transform)

InfluxWriter.prototype._transform = function (delta, encoding, done) {
  this.push(delta)
  this.points = this.points.concat(this.deltaToPoints(delta))

  if (this.points.length > this.batchSize) {
    debug.enabled && debug('Writing')
    const pointsToWrite = this.points
    this.influxP.then(influx => {
      writePoints(influx, pointsToWrite, done)
    }).catch(err => {
      console.error(err)
      done()
    })
    this.points = []
  } else {
    done()
  }
}

InfluxWriter.prototype._flush = function (done) {
  writePoints(this.influx, this.points, done)
}

function writePoints (influx, points, done) {
  influx.writePoints(points).then(() => done()).catch(err => {
    console.error('InfluxDb error: ' + err.message)
    done()
  })
}

module.exports = InfluxWriter
