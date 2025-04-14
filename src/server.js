const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { OUTPUT_FILE } = require('./config');

const app = express();
// 静态文件服务
app.use(express.static(path.join(__dirname, '..', 'public')));
const PORT = process.env.PORT || 3000;
const AUTH_CONFIG_FILE = path.join(__dirname, '..', 'auth-config.json');
const authorizedIPs = new Set();
const authAttempts = new Map(); // 记录IP验证尝试次数

// 读取认证配置
async function loadAuthConfig() {
    try {
        const configStr = await fs.readFile(AUTH_CONFIG_FILE, 'utf8');
        return JSON.parse(configStr);
    } catch (err) {
        // 如果配置文件不存在，创建默认配置
        const defaultConfig = {
            password: 'admin',
            maxAttemptsPerDay: 10
        };
        await fs.writeFile(AUTH_CONFIG_FILE, JSON.stringify(defaultConfig, null, 4));
        return defaultConfig;
    }
}

// 保存认证配置
async function saveAuthConfig(config) {
    await fs.writeFile(AUTH_CONFIG_FILE, JSON.stringify(config, null, 4));
}

let authConfig = {
    password: 'admin',
    maxAttemptsPerDay: 10
};

// 初始加载配置
loadAuthConfig().then(config => {
    authConfig = config;
}).catch(console.error);

// 获取当前日期的字符串（用于重置计数）
const getToday = () => {
    return new Date().toISOString().split('T')[0];
};

// 检查并更新验证尝试次数
const checkAuthAttempts = (ip) => {
    const today = getToday();
    const attempts = authAttempts.get(ip) || {};
    
    // 如果是新的一天，重置计数
    if (attempts.date !== today) {
        attempts.count = 0;
        attempts.date = today;
    }
    
    // 检查是否超过限制
    if (attempts.count >= authConfig.maxAttemptsPerDay) {
        return false;
    }
    
    // 更新尝试次数
    attempts.count += 1;
    authAttempts.set(ip, attempts);
    return true;
};

// 获取剩余尝试次数
const getRemainingAttempts = (ip) => {
    const today = getToday();
    const attempts = authAttempts.get(ip) || { date: today, count: 0 };
    
    if (attempts.date !== today) {
        return authConfig.maxAttemptsPerDay;
    }
    
    return Math.max(0, authConfig.maxAttemptsPerDay - attempts.count);
};

// IP验证中间件
const checkIPAuth = (req, res, next) => {
    const clientIP = req.ip;
    // 跳过验证页面和验证接口
    const skipPaths = ['/auth', '/auth.html', '/auth/attempts'];
    if (skipPaths.includes(req.path) || skipPaths.includes(req.path + '.html')) {
        return next();
    }

    if (authorizedIPs.has(clientIP)) {
        next();
    } else {
        // 如果是API请求，返回403状态码
        if (req.path.startsWith('/api/') || req.accepts('html') !== 'html') {
            res.status(403).json({
                error: '未授权的IP地址'
            });
        } else {
            // 否则重定向到认证页面
            res.redirect('/auth');
        }
    }
};

// 所有请求都经过IP验证
app.use(checkIPAuth);

// 基础状态检查
app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString()
    });
});

// 首页路由
app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'home.html'));
});

// 认证页面路由
app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'auth.html'));
});

// 根路由重定向到home
app.get('/', (req, res) => {
    res.redirect('/home');
});

// 获取合并后的配置文件
// 修改密码接口
app.post('/auth/password', express.json(), checkIPAuth, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    
    if (!oldPassword || !newPassword) {
        res.status(400).json({ error: '需要提供旧密码和新密码' });
        return;
    }
    
    if (oldPassword !== authConfig.password) {
        res.status(401).json({ error: '旧密码错误' });
        return;
    }
    
    authConfig.password = newPassword;
    await saveAuthConfig(authConfig);
    
    res.json({
        status: 'success',
        message: '密码修改成功'
    });
});

// 获取验证尝试状态
app.get('/auth/attempts', (req, res) => {
    const clientIP = req.ip;
    const attempts = authAttempts.get(clientIP) || { date: getToday(), count: 0 };
    const remaining = Math.max(0, authConfig.maxAttemptsPerDay - attempts.count);
    
    res.json({
        ip: clientIP,
        remainingAttempts: remaining,
        totalAttempts: attempts.count,
        maxAttemptsPerDay: authConfig.maxAttemptsPerDay,
        nextResetTime: `${getToday()}T23:59:59`
    });
});

app.post('/auth', express.json(), (req, res) => {
    const { password } = req.body;
    const clientIP = req.ip;

    // 检查尝试次数
    if (!checkAuthAttempts(clientIP)) {
        res.status(429).json({
            error: '今日验证次数已达上限',
            nextResetTime: `${getToday()}T23:59:59`
        });
        return;
    }

    // 获取剩余尝试次数
    const remainingAttempts = getRemainingAttempts(clientIP);

    if (password === authConfig.password) {
        authorizedIPs.add(clientIP);
        res.json({
            status: 'success',
            message: 'IP认证成功',
            remainingAttempts,
            redirect: '/home'
        });
    } else {
        res.status(401).json({
            error: '密码错误',
            remainingAttempts
        });
    }
});

app.get('/config', checkIPAuth, async (req, res) => {
    try {
        const config = await fs.readFile(OUTPUT_FILE, 'utf8');
        res.setHeader('Content-Type', 'text/yaml');
        res.send(config);
    } catch (err) {
        if (err.code === 'ENOENT') {
            res.status(404).json({
                error: '配置文件尚未生成'
            });
        } else {
            console.error('读取配置文件失败:', err);
            res.status(500).json({
                error: '服务器内部错误'
            });
        }
    }
});

// 获取已授权的IP列表
app.get('/auth/list', (req, res) => {
    res.json({
        authorized_ips: Array.from(authorizedIPs)
    });
});

// 移除IP授权
app.delete('/auth', express.json(), (req, res) => {
    const { ip } = req.body;
    if (authorizedIPs.has(ip)) {
        authorizedIPs.delete(ip);
        res.json({
            status: 'success',
            message: `已移除IP: ${ip}`
        });
    } else {
        res.status(404).json({
            error: '未找到该IP'
        });
    }
});

function startServer() {
    app.listen(PORT, () => {
        console.log(`HTTP服务器已启动: http://localhost:${PORT}`);
        console.log(`配置文件地址: http://localhost:${PORT}/config`);
        console.log(`默认验证密码: ${authConfig.password}`);
    });
}

module.exports = {
    startServer
};