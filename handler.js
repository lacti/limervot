'use strict';

const awsServerlessExpress = require('aws-serverless-express');
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();
const bodyParser = require('body-parser');
const server = awsServerlessExpress.createServer(app);

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

const mysql = require('mysql');
const dbConfig = {
  host: process.env.DB_HOST,
  user: 'lmserver',
  password: process.env.DB_PASSWORD,
  database: 'lmserver',
};

const query = (sql) => new Promise((resolve, reject) => {
  let db = mysql.createConnection(dbConfig);
  db.connect();
  db.query(sql, (err, result, fields) => {
    db.end();
    if (err) {
      console.log('error occurred in database query');
      console.log(err);
      reject(err);
    } else {
      resolve(result);
    }
  });
});

app.use(line.middleware(config));
app.use(bodyParser.json());
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);

app.post('/webhook', (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(error => res.json(error));
});

app.post('/noti/:server/:phase', (req, res) => {
  const server = req.params.server;
  const phase = req.params.phase;
  const message = {
    type: 'text',
    text: `(${req.body.host}) ${phase} ${server} ${req.body.text}`
  };
  query(`SELECT id FROM subs WHERE server="${server}" AND phase="${phase}"`).then(result => {
    let userIds = result.filter(e => e.id.startsWith('U')).map(e => e.id);
    let groupIds = result.filter(e => e.id.startsWith('C')).map(e => e.id);
    Promise.all(
        groupIds.map(id => client.pushMessage(id, message))
          .concat(userIds.length > 0 ? client.multicast(userIds, message) : Promise.resolve(null))
        )
      .then(result => res.json(result))
      .catch(error => res.json(error));
  });
});

const help = `안녕하세요!
@[on/off] [server] [phase]로 알람을 조정하고 @status로 상태를 확인할 수 있습니다.
예) @on api all`;
const allOfServers = ['admin', 'api', 'batch', 'billing', 'external-admin', 'web', 'worker'];
const allOfPhases = ['alpha', 'beta', 'rc', 'real'];
const onoff = /@(on|off) ([a-z\-]+) ([a-z\-]+)/;

function handleEvent(event) {
  console.log(event);
  if (
    event.replyToken === '00000000000000000000000000000000' ||
    event.replyToken === 'ffffffffffffffffffffffffffffffff'
  ) {
    return Promise.resolve(null);
  }

  const id = event.source.groupId || event.source.userId;
  if (event.type === 'follow' || event.type == 'join') {
    return query(`REPLACE INTO subs (id, server, phase) VALUES ("${id}", "api", "beta"), ("${id}", "api", "rc"), ("${id}", "admin", "beta")`)
      .then(res => {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: help
        });
      });
  } else if (event.type === 'unfollow' || event.type == 'leave') {
    const id = event.source.groupId || event.source.userId;
    return query(`DELETE FROM subs WHERE id="${id}"`);
  }

  // ignore other events except text
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = (event.message.text || '').toLowerCase();
  if (onoff.test(text)) {
    let cmd = text.match(onoff);
    let op = cmd[1];
    let selectedServers = cmd[2] !== 'all' ? [cmd[2]] : allOfServers;
    let selectedPhases = cmd[3] !== 'all' ? [cmd[3]] : allOfPhases;
    let clauses = [];
    for (let eachServer of selectedServers) {
      for (let eachPhase of selectedPhases) {
        if (op === 'on') {
          clauses.push(`("${id}", "${eachServer}", "${eachPhase}")`);
        } else /* off */ {
          clauses.push(`(server="${eachServer}" AND phase="${eachPhase}")`);
        }
      }
    }
    if (op === 'on') {
      return query(`REPLACE INTO subs (id, server, phase) VALUES ${clauses.join(',')}`);
    } else /* off */ {
      return query(`DELETE FROM subs WHERE id="${id}" AND (${clauses.join(' OR ')})`);
    }
  }
  else if ('@status' === text) {
    return query(`SELECT GROUP_CONCAT(CONCAT(server, '[', phase, ']') ORDER BY server, phase SEPARATOR ', ') AS status FROM subs WHERE id='${id}' GROUP BY id`)
      .then(res => {
        const subs = res[0];
        const status = subs && subs.status ? subs.status : 'empty';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: status
        });
      });
  }
  return Promise.resolve(null);
}

module.exports.express = (event, context) =>
  awsServerlessExpress.proxy(server, event, context);
