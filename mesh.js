/*
  MIT License,
  Copyright (c) 2015, Richard Rodger and other contributors.
*/

'use strict'

var _ = require('lodash')
var Jsonic = require('jsonic')
var Swim = require('swim')


module.exports = function (options) {
  var seneca = this


  // become a base node
  if( options.base ) {
    options.host = options.host || '127.0.0.1'
    options.port = options.port || 39999
    options.pin  = 'role:mesh,base:true'
    options.auto = true
    options.remotes = [options.host + ':' + options.port]
  }

  // merge default options with any provided by the caller
  options = seneca.util.deepextend({
    host: options.host || '127.0.0.1',
    port: function() {
      return 40000 + Math.floor((10000*Math.random()))
    },
    remotes: [(options.basehost || '127.0.0.1') + ':' + (options.baseport || 39999)]
  }, options)


  // single pin(s) entry supported as a convenience
  options.pin = options.pin || options.pins

  var listen = options.listen || [{pin:options.pin}]


  seneca.use( 'balance-client' )

  seneca.add( 'role:transport,cmd:listen', transport_listen )


  if( options.auto ) {
    _.each( listen, function( listen_opts ) {
      var pin = listen_opts.pin || listen_opts.pins

      seneca.root.listen( {
        // seneca-transport will retry until it finds a free port
        port: function() {
          return 50000 + Math.floor((10000*Math.random()))
        },
        pin: listen_opts.pin,
        model: listen_opts.model || 'actor'
      })
    })
  }


  function transport_listen ( msg, done ) {
    this.prior( msg, function( err, out ) {
      if( !err ) {
        join( this, out, done )
      }
      done( err, out )
    })
  }


  var attempts = 0, max_attempts = 11

  var balance_map = {}

  function join( instance, config, done ) {
    config = config || {}

    if( !config.pin ) {
      config.pin = 'null:true'
    }

    var host = options.host + ( options.port ?
                               ':'+(_.isFunction(options.port) ?
                                    options.port() : options.port ) : '' )
    var meta = {
      who: host,
      listen: config,
      instance: instance.id
    }

    var opts = {
      local: {
        host: host,
        meta: meta,
        incarnation: Date.now()
      },
      codec: 'msgpack',
      disseminationFactor: 15,
      interval: 100,
      joinTimeout: 200,
      pingTimeout: 20,
      pingReqTimeout: 60,
      pingReqGroupSize: 3,
      udp: {maxDgramSize: 512},
    }

    var swim = new Swim(opts)

    swim.on(Swim.EventType.Error, function(err) {
      if ('EADDRINUSE' === err.code && attempts < max_attempts) {
        attempts++
        setTimeout(
          function() {
            join( instance, config, done )
          },
          100 + Math.floor(Math.random() * 222)
        )
        return
      }
      else if( err ) {
        // TODO: duplicate call
        return done(err)
      }
    })


    // TODO: this is not being called!
    swim.on(Swim.EventType.Ready, function(){
      done( null, config )
    })

    var remotes = _.compact(options.remotes)

    swim.bootstrap( remotes, function onBootstrap(err) {
      if (err) {
        seneca.log.warn(err)
        return
      }

      _.each( swim.members(), updateinfo )

      swim.on(Swim.EventType.Change, function onChange(info) {
        // TODO: not used
        //updateinfo(info)
      })

      swim.on(Swim.EventType.Update, function onUpdate(info) {
        updateinfo(info)
      })

    })


    function updateinfo( m ) {
      // Ignore updates about myself
      if( m.meta.instance === seneca.id ) {
        return
      }

      if( 0 === m.state ) {
        add_client( m.meta.listen )
      }
      else {
        remove_client( m.meta.listen )
      }
    }


    function add_client( config ) {
      var pins = config.pins || config.pin
      pins = _.isArray(pins) ? pins : [pins]

      _.each( pins, function( pin ) {
        var pin_id = instance.util.pattern(pin)

        var pin_config = _.clone( config )
        delete pin_config.pins
        delete pin_config.pin

        pin_config.pin = pin_id

        var id = instance.util.pattern( pin_config )

        // TODO: how to handle local override?
        var actmeta = instance.find( pin )
        var ignore_client = !!(actmeta && !actmeta.client)

        if( ignore_client ) {
          return
        }

        if( !balance_map[pin_id] ) {
          //console.log('M AC AB '+pin_id)
          instance.root.client( {type:'balance', pin:pin, model:config.model} )
          balance_map[pin_id] = {}
        }

        var target_map = (balance_map[pin_id] = balance_map[pin_id] || {})

        target_map[id] = true

        instance.act(
          'role:transport,type:balance,add:client',
          {config:pin_config} )
      })
    }


    function remove_client( config ) {
      var pins = config.pins || config.pin
      pins = _.isArray(pins) ? pins : [pins]

      _.each( pins, function( pin ) {
        var pin_id = instance.util.pattern(pin)

        var pin_config = _.clone( config )
        delete pin_config.pins
        delete pin_config.pin

        pin_config.pin = pin_id

        var id = instance.util.pattern( pin_config )

        var target_map = balance_map[pin_id]

        if( target_map ) {
          delete target_map[id]
        }

        instance.act(
          'role:transport,type:balance,remove:client',
          {config:pin_config} )
      })

    }
  }
}

