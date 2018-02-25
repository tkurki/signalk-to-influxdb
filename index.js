/*
 * Copyright 2016 Teppo Kurki <teppo.kurki@iki.fi>
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
const Bacon = require('baconjs')
const debug = require('debug')('signalk-to-influxdb')
const util = require('util')

module.exports = function (app) {
  const logError = app.error || ((err) => {console.error(err)})
  let client
  let selfContext = 'vessels.' + app.selfId
  let lastPositionStored = 0
  let recordTrack = false

  let unsubscribes = []
  let shouldStore = function (path) {
    return true
  }

  function handleDelta (delta) {
    if (delta.context === 'vessels.self') {
      delta.context = selfContext
    }

    if (delta.updates && delta.context === selfContext) {
      delta.updates.forEach(update => {
        if (update.values) {
          var points = update.values.reduce((acc, pathValue) => {
            if ( pathValue.path === 'navigation.position' ) {
              if ( recordTrack &&
                   new Date().getTime() - lastPositionStored > 1000
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
                lastPositionStored = new Date().getTime()
              }
            } else if (shouldStore(pathValue.path)) {
              if (typeof pathValue.value === 'number') {
                acc.push({
                  measurement: pathValue.path,
                  fields: {
                    value: pathValue.value
                  }
                })
              } 
            }
            return acc
          }, [])
          if (points.length > 0) {
            client.writePoints(points).catch(logError)
          }
        }
      })
    }
  }

  function toMultilineString (influxResult) {
    let currentLine = []
    const result = {
      type: 'MultiLineString',
      coordinates: []
    }

    influxResult.forEach(row => {
      if (row.position === null) {
        currentLine = []
      } else {
        currentLine[currentLine.length] = JSON.parse(row.position)
        if (currentLine.length === 1) {
          result.coordinates[result.coordinates.length] = currentLine
        }
      }
    })
    return result
  }
  function timewindowStart () {
    return new Date(new Date().getTime() - 60 * 60 * 1000).toISOString()
  }

  return {
    id: 'signalk-to-influxdb',
    name: 'InfluxDb writer',
    description: 'Signal K server plugin that writes self values to InfluxDb',

    schema: {
      type: 'object',
      required: ['host', 'port', 'database'],
      properties: {
        host: {
          type: 'string',
          title: 'Host',
          default: 'localhost'
        },
        port: {
          type: 'number',
          title: 'Port',
          default: 8086
        },
        database: {
          type: 'string',
          title: 'Database'
        },
        resolution: {
          type: 'number',
          title: 'Resolution (ms)',
          default: 200
        },
        recordTrack: {
          type: "boolean",
          title: "Record Track",
          description: "When enabled the vessels position will be stored",
          default: false
        },
        blackOrWhite: {
          type: 'string',
          title: 'Type of List',
          description:
            'With a blacklist, all numeric values except the ones in the list below will be stored in InfluxDB. With a whitelist, only the values in the list below will be stored.',
          default: 'Black',
          enum: ['White', 'Black']
        },
        blackOrWhitelist: {
          title: 'SignalK Paths',
          description:
            'A list of SignalK paths to be exluded or included based on selection above',
          type: 'array',
          items: {
            type: 'string',
            title: 'Path'
          }
        }
      }
    },

    start: function (options) {
      client = new Influx.InfluxDB({
        host: options.host,
        port: options.port, // optional, default 8086
        protocol: 'http', // optional, default 'http'
        database: options.database
      })

      client
        .getDatabaseNames()
        .then(names => {
          if (!names.includes(options.database)) {
            client.createDatabase(options.database).then(result => {
              console.log('Created InfluxDb database ' + options.database)
            })
          }
        })
        .catch(err => {
          console.error(err)
        })

      if (
        typeof options.blackOrWhitelist !== 'undefined' &&
        typeof options.blackOrWhite !== 'undefined' &&
        options.blackOrWhitelist.length > 0
      ) {
        var obj = {}

        options.blackOrWhitelist.forEach(element => {
          obj[element] = true
        })

        if (options.blackOrWhite == 'White') {
          shouldStore = function (path) {
            return typeof obj[path] !== 'undefined'
          }
        } else {
          shouldStore = function (path) {
            return typeof obj[path] === 'undefined'
          }
        }
      }

      recordTrack = options.recordTrack

      app.signalk.on('delta', handleDelta)
    },
    stop: function () {
      unsubscribes.forEach(f => f())
      app.signalk.removeListener('delta', handleDelta)
    },
    signalKApiRoutes: function (router) {
      const trackHandler = function (req, res, next) {
        if (typeof client === 'undefined') {
          console.error(
            'signalk-to-influxdb plugin not enabled, http track interface not available'
          )
          next()
          return
        }

        let query = `
        select first(value) as "position"
        from "navigation.position"
        where time >= now() - ${sanitize(req.query.timespan || '1h')}
        group by time(${sanitize(req.query.resolution || '1m')})`
        client
          .query(query)
          .then(result => {
            res.type('application/vnd.geo+json')
            res.json(toMultilineString(result))
          })
          .catch(err => {
            console.error(err.message + ' ' + query)
            res.status(500).send(err.message + ' ' + query)
          })
      }

      router.get('/self/track', trackHandler)
      router.get('/vessels/self/track', trackHandler)
      router.get('/vessels/' + app.selfId + '/track', trackHandler)
      return router
    }
  }
}

const influxDurationKeys = {
  s: 's',
  m: 'm',
  h: 'h',
  d: 'd',
  w: 'w'
}

function sanitize (influxTime) {
  return (
    Number(influxTime.substring(0, influxTime.length - 1)) +
    influxDurationKeys[
      influxTime.substring(influxTime.length - 1, influxTime.length)
    ]
  )
}
