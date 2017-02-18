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

module.exports = function(app) {
  var client;
  var selfContext = "vessels." + app.selfId

  var unsubscribes = []
  var shouldStore = function(path) { return true; }

  function handleDelta(delta) {
    if(delta.updates && delta.context === selfContext) {
      delta.updates.forEach(update => {
        if(update.values) {
          var points = update.values.reduce((acc, pathValue) => {
            if(typeof pathValue.value === 'number') {
              var storeIt = shouldStore(pathValue.path)
                
              if ( storeIt ) {
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
          if(points.length > 0) {
            client.writePoints(points, function(err, response) {
              if(err) {
                console.error(err)
                console.error(response)
              }
            })
          }
        }
      })
    }
  }

  return {
    id: "signalk-to-influxdb",
    name: "InfluxDb writer",
    description: "Signal K server plugin that writes self values to InfluxDb",

    schema: {
      type: "object",
      required: [
        "host", "port", "database"
      ],
      properties: {
        host: {
          type: "string",
          title: "Host",
          default: "localhost"
        },
        port: {
          type: "number",
          title: "Port",
          default: 8086
        },
        database: {
          type: "string",
          title: "Database"
        },
        storeGroundWind: {
          type: "boolean",
          title: "Store Computed True Ground Wind Speed and Angle",
          default: false
        },
        blackOrWhite: {
          "type": "string",
          "title": "Type of List",
          "description": "With a blacklist, all numeric values except the ones in the list below will be stored in InfluxDB. With a whitelist, only the values in the list below will be stored.",
          "default": "Black",
          "enum": ["White", "Black"]
        },        
        blackOrWhitelist: {
          title: "SignalK Paths",
          description: "A list of SignalK paths to be exluded or included based on selection above",
          type: "array",
          "items": {
            "type": "string",
            "title": "Path"
          }
        },
      }
    },

    start: function(options) {
      client = new Influx.InfluxDB({
        host: 'localhost',
        port: 8086, // optional, default 8086
        protocol: 'http', // optional, default 'http'
        database: options.database
      })

      if ( typeof options.blackOrWhitelist != 'undefined'
           && typeof options.blackOrWhite != 'undefined'
           && options.blackOrWhitelist.length > 0)            
      {
        var obj = {}

        options.blackOrWhitelist.forEach(element => {
          obj[element] = true
        })

        if ( options.blackOrWhite == 'White' ) {
          shouldStore = function(path) {
            return typeof obj[path] != 'undefined'
          }
        } else {
          shouldStore = function(path) {
            return typeof obj[path] == 'undefined'
          }
        }
      }

      app.signalk.on('delta', handleDelta)

      unsubscribes.push(Bacon.combineWith(function(awaDeg, aws, sog, cogDeg) {
            if ( !options.storeGroundWind )
              return []

            const cog = cogDeg / 180 * Math.PI
            const awa = awaDeg / 180 * Math.PI
            return [
              {
                measurement: 'environment.wind.angleTrueGround',
                fields: {
                  value: getGroundWindAngle(sog, aws, awa) + cog
                }
            }, {
                measurement: 'environment.wind.speedOverGround',
                fields: {
                  value: getGroundWindSpeed(sog, aws, awa)
                }
            }
          ]
          }, [
        'environment.wind.angleApparent',
        'environment.wind.speedApparent',
        'navigation.speedOverGround',
        'navigation.courseOverGroundTrue']
          .map(app.streambundle.getSelfStream, app.streambundle))
        .changes()
        .debounceImmediate(200)
        .onValue(points => {
          client.writePoints(points, function(err, response) {
            if(err) {
              console.error(err)
              console.error(response)
            }
          })
        }))
    },
    stop: function() {
      unsubscribes.forEach(f => f())
      app.signalk.removeListener('delta', handleDelta)
    }
  }
}

function getGroundWindAngle(speed, windSpeed, windAngle) {
  var apparentX = Math.cos(windAngle) * windSpeed;
  var apparentY = Math.sin(windAngle) * windSpeed;
  return Math.atan2(apparentY, -speed + apparentX);
};

function getGroundWindSpeed(speed, windSpeed, windAngle) {
  var apparentX = Math.cos(windAngle) * windSpeed;
  var apparentY = Math.sin(windAngle) * windSpeed;
  return Math.sqrt(Math.pow(apparentY, 2) + Math.pow(-speed + apparentX, 2));
};
