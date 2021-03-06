var MessageFactory = require("../messageFactory"),
  LatLon = require('../latlon'),
  util = require("util"),
  async = require("async"),
  Repository = require('../lib/repository'),
  DistanceMatrix = require('../lib/google-distance'),
  RequestRedisCache = require('request-redis-cache'),
  redisClient = require("redis").createClient()
  cache = new RequestRedisCache({ redis: redisClient }),
  mongoClient = require('../mongo_client'),
  city = require('./city'),
  User = require("./user");

function Driver() {
  User.call(this, Driver.OFFDUTY);
  this.tripsRejected = this.tripsRejected || 0; 
  this.tripsAccepted = this.tripsRejected || 0;
}

util.inherits(Driver, User);

var repository = new Repository(Driver);
var DEFAULT_PICKUP_TIME_SECONDS = 20 * 60;

/**
 * Driver States
 */

['OffDuty', 'Available', 'Reserved', 'Dispatching', 'Accepted', 'Arrived', 'DrivingClient', 'PendingRating'].forEach(function (readableState, index) {
  var state = readableState.toUpperCase();
    Driver.prototype[state] = Driver[state] = readableState;
});

Driver.prototype.getSchema = function() {
  var props = User.prototype.getSchema.call(this);
  props.push('vehicle');
  props.push('picture');
  props.push('tripsAccepted');
  props.push('tripsRejected');
  return props;
}

Driver.prototype.login = function(context, callback) {
  // console.log('Driver ' + this.id + ' logged in: ' + this.state + ' connected: ' + this.connected);
  
  this.updateLocation(context);
  if (!this.state) {
    this.changeState(Driver.OFFDUTY);
  }

  this.buildAndLogEvent('SignInRequest', context);
  this.save();

  return MessageFactory.createDriverOK(this, true, this.trip, false);
}

Driver.prototype.logout = function(context) {
  // console.log('Driver ' + this.id + ' logged out');
  
  this.updateLocation(context);
  this.buildAndLogEvent('SignOutRequest', context);
  
  return MessageFactory.createDriverOK(this);
}

Driver.prototype.onDuty = function(context) {
  this.updateLocation(context);

  if (this.state === Driver.OFFDUTY) {
    // console.log('Driver ' + this.id + ' on duty');
    this.changeState(Driver.AVAILABLE);
    this.buildAndLogEvent('GoOnlineRequest', context);

    this.save();
  }

  return MessageFactory.createDriverOK(this);
}

Driver.prototype.offDuty = function(context) {
  this.updateLocation(context);

  if (this.state === Driver.AVAILABLE) {
    // console.log('Driver ' + this.id + ' off duty');

    this.changeState(Driver.OFFDUTY);
    this.buildAndLogEvent('GoOfflineRequest', context);

    this.save();
  }

  return MessageFactory.createDriverOK(this);
}

// TODO: Записывать изменения позиции водителя в массив последовательных координат
// чтобы позже на клиенте их можно было бы плавно анимировать хоть и не в реальном времени (с небольшой задержкой),
// но за время задержки можно выполнить Map Fitting сгладив индивидуальные точки (устранив погрешности GPS), 
// и потом сделать плавную анимацию между точками
// TODO: Записывать если координата действительно отличается, может быть разница всего на 0.00002 тогда она не нужна

// Update driver's position
Driver.prototype.ping = function(context) {
  this.updateLocation(context);

  // Track trip route
  if (this.trip) {
    this.trip.driverPing(context);
  }

  this.logPingEvent(context);

  return MessageFactory.createDriverOK(this, false, this.trip, this.state === Driver.PENDINGRATING);
}

Driver.prototype.cancelPickup = function(context) {
  this.updateLocation(context);

  if (this.state === Driver.DISPATCHING || this.state === Driver.ACCEPTED || this.state === Driver.ARRIVED) {
    this.trip.pickupCanceledDriver(context.message.reason);
    this.changeState(Driver.AVAILABLE);
    this.buildAndLogEvent('PickupCanceledRequest', context);

    this.save();
  }

  return MessageFactory.createDriverOK(this);
}

Driver.prototype.confirm = function(context) {
  this.updateLocation(context);

  if (this.state === Driver.DISPATCHING) {
    this.tripsAccepted += 1;
    this.changeState(Driver.ACCEPTED);
    this.buildAndLogEvent('PickupConfirmedRequest', context);

    this.save();
  }

  return MessageFactory.createDriverOK(this);
}

Driver.prototype.arriving = function(context) {
  this.updateLocation(context);

  if (this.state === Driver.ACCEPTED) {
    this.changeState(Driver.ARRIVED);
    this.buildAndLogEvent('ArrivingRequest', context);

    this.save();    
  }

  return MessageFactory.createDriverOK(this);
}

Driver.prototype.beginTrip = function(context) {
  this.updateLocation(context);

  if (this.state === Driver.ARRIVED) {
    this.changeState(Driver.DRIVINGCLIENT);
    this.buildAndLogEvent('TripStartedRequest', context);

    this.save();
  }

  return MessageFactory.createDriverOK(this);
}

Driver.prototype.finishTrip = function(context) {
  this.updateLocation(context);

  if (this.state === Driver.DRIVINGCLIENT) {
    this.changeState(Driver.PENDINGRATING);
    this.buildAndLogEvent('TripFinishedRequest', context);

    this.save();
  }

  return MessageFactory.createDriverOK(this, false, this.trip, this.state === Driver.PENDINGRATING);
}

Driver.prototype.rateClient = function(context, callback) {
  if (this.state !== Driver.PENDINGRATING) return callback(null, MessageFactory.createDriverOK(this));

  this.updateLocation(context);
  
  require('../backend').rateClient(this.trip.id, context.message.rating, function() {
    this.changeState(Driver.AVAILABLE);
    this.save();

    callback(null, MessageFactory.createDriverOK(this));
  }.bind(this));
}

Driver.prototype.listVehicles = function(callback) {
  require('../backend').listVehicles(this, function(err, vehicles) {
    callback(err, MessageFactory.createDriverVehicleList(this, vehicles));
  }.bind(this));
}

Driver.prototype.selectVehicle = function(context, callback) {
  require('../backend').selectVehicle(this, context.message.vehicleId, function(err, vehicle) {
    if (err) return callback(err);

    this.vehicle = vehicle;
    callback(null, MessageFactory.createDriverOK(this));
  }.bind(this));
}

Driver.prototype.reserveForDispatch = function() {
  if (this.state !== Driver.AVAILABLE) return;

  this.changeState(Driver.RESERVED);
  this.save();
}

// TODO: Если произошла ошибка посылки Заказа водителю, то перевести водителя в AVAILABLE
// и об этом должен узнать объект Trip
Driver.prototype.dispatch = function(client, trip) {
  if (this.state !== Driver.RESERVED) return;

  this.changeState(Driver.DISPATCHING, client);
  this.setTrip(trip);
  this.save();

  this.send(MessageFactory.createDriverPickup(this, trip, client));
}

// Notify driver that Client canceled pickup or pickup timed out
Driver.prototype.notifyPickupCanceled = function(reason) {
  if (Driver.AVAILABLE === this.state) return;

  this.changeState(Driver.AVAILABLE);
  this.send(MessageFactory.createDriverPickupCanceledByClient(this, reason));
  this.save();
}

Driver.prototype.notifyPickupTimeout = function() {
  this.tripsRejected += 1;
  this.notifyPickupCanceled();
}

Driver.prototype.notifyTripBilled = function() {
  // fake driver sends rating without waiting for the fare
  if (this.trip) {
    this.send(MessageFactory.createDriverOK(this, false, this.trip, true));
  }
}

Driver.prototype.onDisconnect = function () {
  var payload = {
    message: {
      latitude: this.location.latitude,
      longitude: this.location.longitude,
      epoch: Math.round(Date.now() / 1000),
      deviceId: this.deviceId
    }
  }

  this.buildAndLogEvent('Disconnect', payload);
}

Driver.prototype._distanceTo = function(location) {
  // FIXME: Оптимизировать позже
  return new LatLon(this.location.latitude, this.location.longitude).distanceTo(new LatLon(location.latitude, location.longitude), 4);
}

Driver.prototype.isDrivingClient = function() {
  return this.state === Driver.DRIVINGCLIENT;
}

Driver.prototype.isAvailable = function() {
  // console.log('Driver ' + this.id + ' connected: ' + this.connected + ' state: ' + this.state);
  return this.connected && this.state === Driver.AVAILABLE;
}

function isAvailable(vehicleViewId, driver, callback) {
  var result = driver.isAvailable();
  if (vehicleViewId)
    result = result && (driver.vehicle.viewId === vehicleViewId);

  callback(result);
}

function findAvailableDrivers(vehicleViewId, callback) {  
  repository.filter(isAvailable.bind(null, vehicleViewId), callback.bind(null, null)); // bind function context and first (err) param to null
}

function round(arg) {
  return Math.round(arg * 10000) / 10000;
}

Driver.prototype._cacheKeyFor = function(pickupLocation) {
  return round(this.location.latitude + this.location.longitude + pickupLocation.latitude + pickupLocation.longitude).toString() + '-' + this.vehicle.viewId;
}

Driver.prototype.queryETAToLocation = function(pickupLocation, callback) {
  var self = this;
  
  console.log(" [*] Query ETA using cache key: %s", this._cacheKeyFor(pickupLocation))

  // Cache Google Distance Matrix query result, we have only 2500 queries per day
  cache.get({
    cacheKey: this._cacheKeyFor(pickupLocation),
    cacheTtl: 5 * 60, // 5 minutes in seconds
    // Dynamic `options` to pass to our `uncachedGet` call
    requestOptions: {},
    // Action to use when we cannot retrieve data from cache
    uncachedGet: function (options, cb) {
      DistanceMatrix.get(self.location, pickupLocation, function(err, data) {
        // Store only approximate driving duration, instead of whole result to save memory
        if (!err) {
          console.log(" [*] Google Distance Matrix query: %s", Math.ceil(data.durationSeconds / 60))

          // To get more accurate estimate multiply by 1.2
          data = { durationSeconds: data.durationSeconds * 1.2 }

          // FIXME:
          if (city.isCyclist(self.vehicle.viewId)) {
            data.durationSeconds *= 2; // average driving speed 60 km/h, average cycling speed 20 km/h
          }
        }
          
        cb(err, data);
      });
    }
  }, function handleData (err, data) {

    if (err) {
      data = { durationSeconds: DEFAULT_PICKUP_TIME_SECONDS };
      console.log(err);
    }

    var eta = Math.ceil(data.durationSeconds / 60);
    if (eta === 0) eta = 2;

    console.log(" [*] Final ETA: %s", eta);

    callback(null, eta);
  });
}

Driver.prototype.toJSON = function() {
  var obj = User.prototype.toJSON.call(this);
  if (this.trip) {
    obj.trip = {
      id: this.trip.id,
      pickupLocation: this.trip.pickupLocation,
      route: this.trip.route
    }
  }
  return obj;
}

Driver.prototype.save = function() {
  repository.save(this);
}

Driver.prototype.changeState = function(state, client) {
  User.prototype.changeState.call(this, state);
  
  if (this.state === Driver.AVAILABLE) {
    this.emit('available', this);
    this.clearTrip();
  }
  else {
    this.emit('unavailable', this, client);
  }
}

function queryDriversETAToLocation(location, drivers, callback) {
  async.map(drivers, function(driver, next) {
    driver.queryETAToLocation(location, function(err, eta) {
      var vehicle = {
        id: driver.vehicle.id,
        longitude: driver.location.longitude, 
        latitude: driver.location.latitude,
        epoch: driver.location.epoch || 0,
        course: driver.location.course || 0,
        viewId: driver.vehicle.viewId,
        eta: eta
      };

      next(null, vehicle);
    });
  }, callback);
}

Driver.allAvailableNear = function(clientLocation, callback) {
  async.waterfall([
    findAvailableDrivers.bind(null, null),
    queryDriversETAToLocation.bind(null, clientLocation)
  ], callback);
}

Driver.availableSortedByDistanceFrom = function(pickupLocation, vehicleViewId, callback) {
  async.waterfall([
    findAvailableDrivers.bind(null, vehicleViewId),
    // find distance to each driver
    function(availableDrivers, nextFn) {
      console.log("Available drivers:");
      console.log(util.inspect(availableDrivers));

      async.map(
        availableDrivers,
        function(driver, cb) {
          // distance from client in km
          var distanceToClient = driver._distanceTo(pickupLocation);
          cb(null, { driver: driver, distanceToClient: distanceToClient });
        }, 
        nextFn
      );      
    },
    // order drivers by distance
    function(driversAndDistances, nextFn) { 
      console.log("Available drivers with distance to pickup location:");
      console.log(util.inspect(driversAndDistances));

      async.sortBy(
        driversAndDistances, 
        function(item, cb) { cb(null, item.distanceToClient) },
        nextFn
      );
    }
  ], callback);
}

Driver.publishAll = function() {
  repository.all(function(err, drivers) {
    drivers.forEach(function(driver) {
      driver.publish();
    });
  });
}

///////////////////////////////////////////////////////////////////////////////
/// Log Events
/// 
var EPSILON = 0.000002;

function equalLocations(location1, location2) {
  return (Math.abs(location1[0] - location2[0]) <= EPSILON) && (Math.abs(location1[1] - location2[1]) <= EPSILON);
}

Driver.prototype.logPingEvent = function(context) {
  // find last ping location
  mongoClient.collection('driver_events').findOne({$query: {eventName: 'PositionUpdateRequest'}, $orderby: { epoch : -1 }}, function(err, lastPing) {
    if (err) return console.log(err);

    // log only if location changed to save space
    if (!equalLocations(lastPing.location, [context.message.longitude, context.message.latitude])) {
      var event = this.buildEvent('PositionUpdateRequest', context);
      event.horizontalAccuracy = context.message.horizontalAccuracy;
      event.verticalAccuracy = context.message.verticalAccuracy;

      logEvent(event);
    }
  }.bind(this));    
}

Driver.prototype.buildEvent = function(eventName, context) {
  var payload = context.message;
  var event = {
    driverId: this.id,
    state: this.state,
    eventName: eventName,
    location: [payload.longitude, payload.latitude],
    epoch: payload.epoch,
    deviceId: payload.deviceId,
    appVersion: payload.appVersion
  }

  return event;
}

Driver.prototype.buildAndLogEvent = function(eventName, context) {
  logEvent(this.buildEvent(eventName, context));
}

function logEvent(event) {
  mongoClient.collection('driver_events').insert(event, function(err, replies){
    if (err) console.log(err);
  });
}

// export Driver constructor
module.exports.Driver = Driver;
module.exports.repository = repository;