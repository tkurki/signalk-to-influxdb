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
const _ = require('lodash')
const { getSourceId } = require('@signalk/signalk-schema')

var lastUpdates = {}
var lastPositionStored = {}

function addSource(update, tags) {
  if ( update['$source'] ) {
    tags.source = update['$source']
  } else if ( update['source'] ) {
    tags.source = getSourceId(update['source'])
  }
  return tags
}

module.exports = {
  deltaToPointsConverter: (
    selfContext,
    recordTrack,
    shouldStore,
    resolution,
    storeOthers,
    honorDeltaTimestamp = true
  ) => {
    return delta => {
    
      if (delta.context === 'vessels.self') {
        delta.context = selfContext
      }
      let points = []
      if (delta.updates && (storeOthers || delta.context === selfContext)) {
        delta.updates.forEach(update => {
          if (update.values) {
            let date = honorDeltaTimestamp ? new Date(update.timestamp) : new Date()
            let time = date.getTime()
            let tags = addSource(update, { context: delta.context })

            update.values.reduce((acc, pathValue) => {
     
              if (pathValue.path === 'navigation.position') {
                if ( shouldStorePositionNow(delta, recordTrack, time) ) {
                  const point = {
                    measurement: pathValue.path,
                    tags: tags,
                    timestamp: date,
                    fields: {
                      jsonValue: JSON.stringify({
                        longitude: pathValue.value.longitude,
                        latitude: pathValue.value.latitude
                      })
                    }
                  }
                  acc.push(point)
                  lastPositionStored[delta.context] = time
                }
              } else if (shouldStoreNow(delta, pathValue.path, shouldStore, time, resolution)) {
                if ( !lastUpdates[delta.context] )
                  lastUpdates[delta.context] = {}
                lastUpdates[delta.context][pathValue.path] = time
                if (pathValue.path === 'navigation.attitude') {
                  storeAttitude(date, pathValue, tags, acc)
                } else {
                  function addPoint(path, value) {
                    let valueKey = null
                    
                    if ( typeof value === 'number' &&
                         !isNaN(value) ) {
                      valueKey = 'value'
                    } else if ( typeof value === 'string' ) {
                      valueKey = 'stringValue'
                    } else if ( typeof value === 'boolean' ) {
                      valueKey = 'boolValue'
                    } else {
                        valueKey = 'jsonValue'
                      value = JSON.stringify(value)
                    }
                    
                    if ( valueKey ) {
                      const point = {
                        measurement: path,
                        timestamp: date,
                        tags: tags,
                        fields: {
                          [valueKey]: value
                        }
                      }
                      acc.push(point)
                    }
                  }
                  
                  if ( pathValue.path === '' ) {
                    _.keys(pathValue.value).forEach(key => {
                        addPoint(key, pathValue.value[key])
                    })
                  } else {
                    addPoint(pathValue.path, pathValue.value)
                  }
                }
              }
              return acc
            }, points)
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

function shouldStorePositionNow(delta, recordTrack, time) {
  return recordTrack
    && (!lastPositionStored[delta.context]
        || time - lastPositionStored[delta.context] > 1000)
}

function shouldStoreNow(delta, path, shouldStore, time, resolution) {
  return shouldStore(path)
    && (!lastUpdates[delta.context] || !lastUpdates[delta.context][path] ||
        time - lastUpdates[delta.context][path] > resolution || path == '' )
}

  
function storeAttitude(date, pathValue, tags, acc) {
  ['pitch', 'roll', 'yaw'].forEach(key => {
    if (typeof pathValue.value[key] === 'number' &&
        !isNaN(pathValue.value[key])) {
      acc.push({
        measurement: `navigation.attitude.${key}`,
        timestamp: date,
        tags: tags,
        fields: {
          value: pathValue.value[key]
        }
      })
    }
  })
}
