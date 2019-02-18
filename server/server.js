const http = require('http');
var server = http.createServer(handler);
var io = require('socket.io')(server);
const dgram = require('dgram');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const config = require('../config');
const rfactor = require('./rfactor');
const hotlaps = require('./hotlaps');
const mapbuilder = require('./mapbuilder');
const Tracker = require('./tracker');
const classcolors = require('../config/classes');

var state = new Object();
state.track = '';
state.session = '';
state.currtime = 0;
state.endtime = null;
state.maxlaps =  null;
state.drivers;
state.phase = new Object();
state.phase.name = '';
state.phase.yellow = '';
state.phase.sectors = [0,0,0];
var timer;
var exists = false;
var sessionbests = new Tracker();

server.listen(config.HTTP_LISTEN_PORT);
console.log('HTTP listening on ' + config.HTTP_LISTEN_PORT);

function handler (req, res) {
  var uri = url.parse(req.url);
  
  switch(uri.pathname) {
    case '/':
    case '/index.html':
      sendFile(res, path.join('www', 'index.html'), 'text/html');
      break;
    case '/init':
      res.writeHead(200, {'Content-type': 'application/json'});
      let content = new Object();
      content.title = config.BASE_TITLE;
      content.heading = config.PAGE_HEADING;
      content.link = config.JOIN_LINK;
      content.info = state;
      delete content.info.drivers;
      if(state.track == '')
        content.info.track = hotlaps.getTrack();
      content.data = hotlaps.getData();
      res.end(JSON.stringify(content), 'utf-8');
      break;
    case '/live':
      sendFile(res, path.join('www', 'live.html'), 'text/html');
      break;
    case '/map':
      sendFile(res, path.join('www', 'map.html'), 'text/html');
      break;
    case '/socket.js':
      sendFile(res, path.join('client', 'socket.js'), 'application/javascript');
      break;
    case '/home.js':
      sendFile(res, path.join('client', 'home.js'), 'application/javascript');
      break;
    case '/session.js':
      sendFile(res, path.join('client', 'session.js'), 'application/javascript');
      break;
    case '/live.js':
      sendFile(res, path.join('client', 'live.js'), 'application/javascript');
      break;
    case '/map.js':
      sendFile(res, path.join('client', 'map.js'), 'application/javascript');
      break;
    case '/TomorrowNight.css':
      sendFile(res, path.join('www', 'css', uri.pathname), 'text/css');
      break;
    default:
      send404(res);
  }
}

function sendFile(res, file, contenttype) {
  fs.readFile(file, function(error, content) {
    if(error)
      send404(res);
    else {
      res.writeHead(200, {'Content-type': contenttype});
      res.end(content, 'utf-8');
    }
  });
}

function send404(res) {
    res.writeHead(404, {'Content-type': 'text/html'});
    res.end('404 File not found', 'utf-8');
}

io.on('connection', function (socket) {
  if(socket.handshake.address == config.IPV4_LOOPBACK || socket.handshake.address == '::ffff:' + config.IPV4_LOOPBACK || socket.handshake.address == '::1') {
    socket.on('kill', function () {
      console.log('Terminating');
      userver.close();
      setTimeout(() => {
        process.exit(0);
      }, 8000);
    });
  }
  
  socket.on('join', function (room) {
    socket.join(room);
    if(room == 'map') {
      socket.emit('classes', classcolors);
      if(exists)
        socket.emit('map', mapbuilder.getTrackMap());
    } else if(room == 'live')
      socket.emit('bests', sessionbests.bests);
  });
});

const userver = dgram.createSocket('udp4');

userver.on('error', (err) => {
  console.log(`server error:\n${err.stack}`);
  userver.close();
});

userver.on('message', (msg, rinfo) => {
  if(rinfo.address != config.RF2_SRC_ADDR)
    return;
  if(typeof timer !== "undefined")
    clearTimeout(timer);
  let packet = rfactor.parseUDPPacket(msg);
  if(typeof packet === "undefined")
    return;
  if(packet.trackname != state.track || packet.sessionname != state.session || state.currtime > packet.currtime) {
    if(packet.trackname != state.track)
      io.emit('refresh');
    state.track = packet.trackname;
    state.session = packet.sessionname;
    state.currtime = packet.currtime;
    state.endtime = packet.endtime;
    state.maxlaps =  packet.maxlaps;
    state.phase.name = packet.phasename;
    state.phase.yellow = packet.yellowname;
    state.phase.sectors = packet.sectorflag;
    sessionbests = new Tracker();
    io.to('live').emit('session', state);
    io.to('live').emit('bests', sessionbests.bests);
    io.to('map').emit('clear');
    exists = mapbuilder.start(packet.trackname);
    if(exists)
      io.to('map').emit('map', mapbuilder.getTrackMap());
    hotlaps.onUpdate(packet.trackname, packet.sessionname, null, [])
  } else {
    state.currtime = packet.currtime;
    if(state.phase.name != packet.phasename || state.phase.yellow != packet.yellowname || state.phase.sectors[0] != packet.sectorflag[0] || state.phase.sectors[1] != packet.sectorflag[1] || state.phase.sectors[2] != packet.sectorflag[2]) {
      state.phase.name = packet.phasename;
      state.phase.yellow = packet.yellowname;
      state.phase.sectors = packet.sectorflag;
      io.to('live').emit('phase', state.phase);
    }
  }
  let drivers = rfactor.getDriversMap(packet.veh);
  if(typeof drivers !== "undefined") {
    io.to('map').emit('veh', rfactor.getVehPos(packet.veh));
    let bests = sessionbests.onUpdate(packet.veh);
    if(bests != null) {
      io.to('live').emit('bests', bests);
    }
    io.to('live').emit('vehs', packet.veh);
    let temp = exists;
    if(!exists)
      exists = mapbuilder.onUpdate(packet.veh);
    if(temp !== exists)
      io.to('map').emit('map', mapbuilder.getTrackMap());
    if(typeof state.drivers !== "undefined") {
      if(!rfactor.compareDriversMaps(drivers, state.drivers)) {
        state.drivers = drivers;
      }
    } else {
      state.drivers = drivers;
    }
  } else if(typeof state.drivers !== "undefined") {
    io.to('live').emit('vehs', packet.veh);
    state.drivers = drivers;
  }
  let events = rfactor.parseEventStream(packet.results);
  if(typeof events === "undefined")
    console.log('udef');
  if(typeof events.score[0] === "undefined")
    ;
  else {
    let updates = hotlaps.onUpdate(packet.trackname, packet.sessionname, drivers, events.score);
    if(typeof updates !== "undefined") {
      io.to('hotlaps').emit('hotlap', updates);
    }
  }
  if(events.chat.length > 0)
    io.to('chat').emit('message', events.chat);
  timer = setTimeout(function() {
    console.log('rF2 server offline');
    state = new Object();
    state.track = hotlaps.getTrack();
    state.session = '';
    state.currtime = 0;
    state.endtime = null;
    state.maxlaps =  null;
    state.drivers = null;
    state.phase = new Object();
    state.phase.name = '';
    state.phase.yellow = '';
    state.phase.sectors = [0,0,0];
    sessionbests = new Tracker();
    io.to('live').emit('session', state);
    io.to('live').emit('bests', sessionbests.bests);
  }, 5000);
});

userver.on('listening', () => {
  const address = userver.address();
  console.log('RF2  listening on ' + config.RF2_LISTEN_PORT);
});

userver.bind(config.RF2_LISTEN_PORT);
