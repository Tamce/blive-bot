import { KeepLiveWS } from 'tiny-bilibili-ws';
import axios from 'axios';
import log4js from 'log4js';
import fs from 'fs';
import yaml from 'js-yaml';
import { Database } from './db.mjs';

var config = {
  room: 0,
  headers: {
    Cookie: '',
  },
  jct: '',
  uid: 0,
};

try {
  config = yaml.load(fs.readFileSync('config.yaml', 'utf8'));
} catch (error) {
  console.error('读取配置文件 config.yaml 失败');
  process.exit(1);
}
const room = config.room;
const admin = config.admin || [];

// 初始化日志
log4js.configure({
  appenders: {
    out: { type: 'stdout' },
    file: { type: 'file', filename: 'blive.log' },
  },
  categories: {
    default: { appenders: ['out', 'file'], level: 'debug' },
  },
});
const logger = log4js.getLogger('blive');
const db = new Database();

let configForDebug = JSON.parse(JSON.stringify(config));
configForDebug.headers = { ...config.headers, Cookie: '***' }; // 避免输出敏感信息
configForDebug.jct = '******';
logger.info('LOAD CONFIG', configForDebug);

const dbTimer = setInterval(() => {
  try {
    db.save();
  } catch (error) {
    logger.error('保存数据库失败:', error);
  }
}, 1000 * 30);

// 礼物队列管理
const giftQueue = new Map(); // 存储用户礼物信息：uid -> {uname, gifts, blindBoxProfit, timer}
const msgQueue = []; // 存储待发送的消息
var msgTimer = null; // 定时器，用于定时发送消息

async function sendMsg(roomId, msg, config) {
  if (!msgTimer) {
    msgTimer = setInterval(async () => {
      if (msgQueue.length > 0) {
        const message = msgQueue.shift();
        try {
          await sendMsgRaw(roomId, message, config);
        } catch (error) {
          logger.error('发送消息失败:', error.message);
        }
      } else {
        clearInterval(msgTimer);
        msgTimer = null;
      }
    }, 3000); // 每3秒发送一条消息
  }


  if (msg.length > 20) {
    const parts = msg.match(/.{1,20}/g) || [];
    for (const part of parts) {
      msgQueue.push(part);
    }
  } else {
    msgQueue.push(msg);
  }
}
/**
 * 发送消息到直播间
 * @param {number} roomId 直播间ID
 * @param {string} msg 消息内容
 * @param {Object} config 配置信息
 */
async function sendMsgRaw(roomId, msg, config) {
  try {
    
    const formData = {
      csrf: config.jct,
      csrf_token: config.jct,
      roomid: roomId,
      msg: msg,
      fontsize: 25,
      color: 16772431,
      bubble: 0,
      rnd: Math.floor(Date.now() / 1000),
      statistics: '{"appId":100,"platform":5}',
      room_type: 0,
      mode: 1,
      reply_type: 0,
      reply_mid: 0,
      reply_attr: 0
    };
    
    const response = await axios.post(
      'https://api.live.bilibili.com/msg/send',
      formData,
      {
        headers: {
          ...config.headers,
          'Content-Type': 'multipart/form-data'
        }
      }
    );
    
    logger.info('发送消息:', msg, response.status, response.statusText, response.data.msg);
    if (response.status != 200) {
      logger.error('发送消息失败:', response.status, response.statusText, response.data);
    }
    return response.data;
  } catch (error) {
    logger.error('发送消息失败:', error.message);
    throw error;
  }
}

/**
 * 格式化礼物信息
 * @param {Object} gift 原始礼物数据
 * @returns {Object} 格式化后的礼物信息
 */
function formatGiftMessage(gift) {
  const data = gift.data.data;
  
  return {
    uid: data.uid,
    uname: data.uname,
    name: data.giftName,
    num: data.num,                              // 礼物数量
    price: data.price,                          // 礼物实际电池*100
    totalCoin: data.total_coin,                 // 用户实际花费的电池*100，如果是多个的话是原始价格*num，理论上是 originGiftPrice*num
    discountPrice: data.discount_price,         // 礼物实际电池*100，目前看跟 price 一样
    originName: data.blind_gift?.original_gift_name || data.giftName,
    originGiftPrice: data.blind_gift?.original_gift_price || data.price, // 单个礼物的原始电池*100
    isBlindGift: data.blind_gift != null,       // 是否盲盒礼物
    comboTotalCoin: data.combo_total_coin || 0, // 连击的时候会统计在当前连击组内的电池*100，其实不用管，基本用不上
  };
}

/**
 * 处理礼物事件（聚合5秒内的礼物）
 * @param {Object} gift 礼物信息
 */
function handleGiftEvent(gift) {
  // 1. 获取或创建用户队列项
  let queueItem = giftQueue.get(gift.uid);
  
  if (!queueItem) {
    queueItem = {
      uid: gift.uid,
      uname: gift.uname,
      gifts: new Map(), // 礼物名称 -> 数量
      blindBoxProfit: 0, // 盲盒盈亏
      timer: null
    };
    giftQueue.set(gift.uid, queueItem);
  }
  
  // 2. 更新礼物数量
  const currentCount = queueItem.gifts.get(gift.name) || 0;
  queueItem.gifts.set(gift.name, currentCount + gift.num);
  
  // 3. 计算盲盒盈亏
  if (gift.isBlindGift && gift.originGiftPrice != gift.price) {
    const profit = (gift.price - gift.originGiftPrice) * gift.num;
    queueItem.blindBoxProfit += profit;
  }
  
  // 4. 重置定时器（5秒后发送感谢消息）
  if (queueItem.timer) {
    clearTimeout(queueItem.timer);
  }
  
  queueItem.timer = setTimeout(() => {
    statGiftCounter(queueItem);
    sendAggregatedGift(queueItem);
    giftQueue.delete(gift.uid);
  }, 5000); // 5秒聚合窗口
}

async function statGiftCounter(item) {
  let counter = db.get('counter')
  if (!counter) counter = 0;
  if (item.blindBoxProfit !== 0) {
    counter += -1 * Math.floor(item.blindBoxProfit / 100 / 10);
  }
  db.set('counter', counter);
}

/**
 * 发送聚合后的礼物感谢消息
 * @param {Object} item 礼物聚合信息
 */
async function sendAggregatedGift(item) {
  try {
    // 1. 构建礼物描述
    const giftDescriptions = [];
    for (const [name, count] of item.gifts.entries()) {
      if (count == 1) {
        giftDescriptions.push(name);
      } else {
        giftDescriptions.push(`${count}个${name}`);
      }
    }
    
    // 2. 构建感谢消息
    let message = `谢谢${item.uname}送出的${giftDescriptions.join('、')}`;
    
    // 3. 添加盲盒盈亏信息
    if (item.blindBoxProfit !== 0) {
      const profitType = item.blindBoxProfit > 0 ? '赚' : '亏';
      message += `，盲盒${profitType}${Math.abs(item.blindBoxProfit)/100}电池`;
      message += `，蹲起${db.get('counter') || 0}个(${-1*Math.floor(item.blindBoxProfit/100/10)})`;
    }
    
    // 4. 发送消息
    await sendMsg(room, message, config);
  } catch (error) {
    logger.error('发送聚合礼物消息失败:', error.message);
  }
}

/**
 * 启动直播间监听
 */
function startLiveMonitor() {
  logger.info(`开始监听直播间 ${room}...`);
  
  const live = new KeepLiveWS(room, config);
  
  live.runWhenConnected(() => {
    logger.info(`已连接到直播间 ${room}`);
  });
  
  live.on('DANMU_MSG', (danmu) => {
    const info = danmu.data.info;
    const user = info[2][1];
    const content = info[1];
    const level = info[3][0];
    logger.info(`弹幕: ${user}: ${content}`);
    if (level >= 10 && content == '还要做多少蹲起') {
      let counter = db.get('counter') || 0
      let suffix = '';
      if (counter > 100) suffix = 'QAQ 加油捏'
      sendMsg(room, `还要做 ${counter} 个蹲起${suffix}`, config);
    }
    if (level >= 10) {
      if (content == '机器人还活着吗') {
        let texts = [
          '今天又多活了一天真高兴！',
          '到！',
          '在的捏 ⌯\'▾\'⌯',
          '咕噜咕噜咕噜咕噜（溺水声）',
          '你爷爷在此！',
        ];
        sendMsg(room, texts[Math.floor(Math.random()*texts.length)], config);
      }
      let m = content.match(/^蹲起=(\d+)$/);
      if (m) {
        const newCounter = parseInt(m[1]);
        db.set('counter', newCounter);
        sendMsg(room, `已设置蹲起计数器为 ${newCounter}`, config);
      }
    }
  });
  
  live.on('SEND_GIFT', (gift) => {
    const data = formatGiftMessage(gift);
    logger.info('收到礼物:', `${data.uname} 送出了 ${data.num} 个 ${data.name}`,
      'coin', data.totalCoin, 'dp', data.discountPrice,
      'p', data.price, 'op', data.originGiftPrice,
      data.originName,
    );
    logger.debug('原始礼物数据:', JSON.stringify(data));
    handleGiftEvent(data);
  });
  
  live.on('INTERACT_WORD', (data) => {
    const username = data.data.data.uname;
    logger.info(`用户进入: ${username} 进入了直播间`);
  });
  
  live.on('error', (error) => {
    logger.error('连接错误:', error.message);
  });
  
  live.on('close', () => {
    logger.info(`已断开与直播间 ${room} 的连接`);
  });
  
  return live;
}

/**
 * 主函数
 */
async function main() {
  try {
    logger.info('===== B站直播间礼物助手已启动 =====');
    logger.info(`正在连接直播间: ${room}`);
    
    const live = startLiveMonitor();
    
    // 处理程序退出
    process.on('SIGINT', () => {
      logger.info('正在关闭程序...');
      db.save();
      clearInterval(dbTimer);
      live.close();
      logger.info('程序已退出');
      process.exit();
    });
    
    process.on('uncaughtException', (error) => {
      logger.error('未捕获异常:', error);
      live.close();
      process.exit(1);
    });
  } catch (error) {
    logger.error('程序启动失败:', error);
    process.exit(1);
  }
}

// 启动程序
main();
