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

const Influx = require('influx')
const debug = require('debug')('signalk-to-influxdb')

var lastUpdates = {}

module.exports = {
  deltaToPointsConverter: (
    selfContext,
    recordTrack,
    shouldStore,
    resolution,
    useDeltaTimestamp = false
  ) => {
    return delta => {
      if (delta.context === 'vessels.self') {
        delta.context = selfContext
      }
      let points = []
      if (delta.updates && delta.context === selfContext) {
        delta.updates.forEach(update => {
          if (update.values) {
            let date = new Date(update.timestamp)
            let time = date.getTime()
            points = update.values.reduce((acc, pathValue) => {
              if (pathValue.path === 'navigation.position') {
                if (
                  recordTrack &&
                  time - lastPositionStored > 1000
                ) {
                  acc.push({
                    measurement: pathValue.path,
                    fields: {
                      value: JSON.stringify([
                        pathValue.value.longitude,
                        pathValue.value.latitude
                      ])
                    }
                  })
                  lastPositionStored = Date.now()
                }
              } else if (shouldStore(pathValue.path)) {
                if ( !lastUpdates[pathValue.path] || time - lastUpdates[pathValue.path] > resolution ) {
                  lastUpdates[pathValue.path] = time
                  if (pathValue.path === 'navigation.attitude') {
                    if (typeof pathValue.value.pitch === 'number' && !isNaN(pathValue.value.pitch)) {
                      acc.push({
                        measurement: 'navigation.attitude.pitch',
                        fields: {
                          value: pathValue.value.pitch
                        }
                      })
                    }
                    if (typeof pathValue.value.roll === 'number' && !isNaN(pathValue.value.roll)) {
                      acc.push({
                        measurement: 'navigation.attitude.roll',
                        fields: {
                          value: pathValue.value.roll
                        }
                      })
                    }
                    if (typeof pathValue.value.yaw === 'number' && !isNaN(pathValue.value.yaw)) {
                      acc.push({
                        measurement: 'navigation.attitude.yaw',
                      fields: {
                        value: pathValue.value.yaw
                      }
                      })
                    }
                  } else if (
                    typeof pathValue.value === 'number' &&
                      !isNaN(pathValue.value)
                  ) {
                    const point = {
                      measurement: pathValue.path,
                      fields: {
                        value: pathValue.value
                      }
                    }
                    if (useDeltaTimestamp) {
                      point.timestamp = date
                    }
                    acc.push(point)
                  }
                }
              }
              return acc
            }, [])
          }
        })
      }
      return points
    }
  },
  influxClientP: ({ host, port, database }) => {
    debug(`Attempting connection to ${host}${port} ${database}`)
    return new Promise((resolve, reject) => {
      const client = new Influx.InfluxDB({
        host: host,
        port: port, // optional, default 8086
        protocol: 'http', // optional, default 'http'
        database: database
      })

      client
        .getDatabaseNames()
        .then(names => {
          debug('Connected')
          if (names.includes(database)) {
            resolve(client)
         } else {
            client.createDatabase(database).then(result => {
              debug('Created InfluxDb database ' + database)
              resolve(client)
            })
          }
        })
        .catch(err => {
          reject(err)
        })
    })
  }
}
