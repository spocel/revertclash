const fs = require('fs').promises;
const YAML = require('yaml');
const axios = require('axios');
const path = require('path');
const URL = require('url');

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, '..', 'clash-urls.txt');
const OUTPUT_FILE = path.join(__dirname, '..', 'merged-config.yaml');

// Clash Verge的请求头
const CLASH_HEADERS = {
    'User-Agent': 'Clash Verge',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br'
};

async function readUrls() {
    try {
        const content = await fs.readFile(CONFIG_FILE, 'utf8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            await fs.writeFile(CONFIG_FILE, '# 在此文件中添加Clash配置URL，每行一个\n');
            console.log('已创建空的URL配置文件');
        } else {
            console.error('读取配置URL文件失败:', err.message);
        }
        return [];
    }
}

function isBase64(str) {
    try {
        return Buffer.from(str, 'base64').toString('base64') === str;
    } catch (err) {
        return false;
    }
}

function parseSSURI(uri) {
    try {
        const url = new URL.URL(uri);
        const [method, password] = Buffer.from(url.username, 'base64')
            .toString()
            .split(':');
        
        // 提取节点名称
        const name = decodeURIComponent(url.hash.substring(1));
        
        return {
            name: name || `${url.hostname}:${url.port}`,
            type: 'ss',
            server: url.hostname,
            port: parseInt(url.port),
            cipher: method,
            password: password
        };
    } catch (err) {
        console.error('解析SS URI失败:', err.message);
        return null;
    }
}

function parseVlessURI(uri) {
    try {
        const url = new URL.URL(uri);
        const params = url.searchParams;
        
        // 提取节点名称
        const name = decodeURIComponent(url.hash.substring(1));
        
        return {
            name: name || `${url.hostname}:${url.port}`,
            type: 'vless',
            server: url.hostname,
            port: parseInt(url.port),
            uuid: url.username,
            network: params.get('type') || 'tcp',
            tls: params.get('security') === 'tls' || params.get('security') === 'reality',
            reality: params.get('security') === 'reality' ? {
                public_key: params.get('pbk'),
                short_id: params.get('sid')
            } : undefined,
            flow: params.get('flow'),
            'skip-cert-verify': true
        };
    } catch (err) {
        console.error('解析Vless URI失败:', err.message);
        return null;
    }
}

function parseProxyURI(uri) {
    if (uri.startsWith('ss://')) {
        return parseSSURI(uri);
    } else if (uri.startsWith('vless://')) {
        return parseVlessURI(uri);
    }
    return null;
}

function convertURIsToClashConfig(uris) {
    const proxies = [];
    
    for (const uri of uris.split('\n')) {
        const trimmedUri = uri.trim();
        if (!trimmedUri || trimmedUri.startsWith('#')) continue;
        
        const proxy = parseProxyURI(trimmedUri);
        if (proxy) {
            proxies.push(proxy);
        }
    }
    
    if (proxies.length === 0) {
        return null;
    }
    
    return {
        proxies,
        'proxy-groups': [{
            name: '🚀 节点选择',
            type: 'select',
            proxies: proxies.map(p => p.name)
        }]
    };
}

async function downloadConfig(url) {
    try {
        // 使用Clash Verge UA下载
        const response = await axios.get(url, {
            headers: CLASH_HEADERS,
            timeout: 10000 // 10秒超时
        });
        
        let config = response.data;

        // 如果返回的是字符串，检查是否是Base64编码
        if (typeof config === 'string') {
            // 尝试检测并解码Base64内容
            if (isBase64(config)) {
                const decodedConfig = Buffer.from(config, 'base64').toString('utf8');
                
                // 尝试将URI格式转换为Clash配置
                const uriConfig = convertURIsToClashConfig(decodedConfig);
                if (uriConfig) {
                    console.log('成功将URI格式转换为Clash配置');
                    return uriConfig;
                }
                
                // 如果不是URI格式，尝试解析为YAML
                try {
                    config = YAML.parse(decodedConfig);
                    console.log('成功解码Base64配置');
                } catch (err) {
                    console.error('解析Base64配置失败:', err.message);
                    return null;
                }
            } else {
                // 检查是否是URI格式
                const uriConfig = convertURIsToClashConfig(config);
                if (uriConfig) {
                    return uriConfig;
                }
                
                // 尝试解析为YAML
                try {
                    config = YAML.parse(config);
                } catch (err) {
                    console.error('解析YAML配置失败:', err.message);
                    return null;
                }
            }
        }

        // 验证配置格式
        if (!config || !Array.isArray(config.proxies)) {
            console.error('无效的Clash配置格式:', url);
            return null;
        }

        // 只保留proxies，去除其他配置
        return {
            proxies: config.proxies
        };
    } catch (err) {
        console.error(`下载配置失败 ${url}:`, err.message);
        return null;
    }
}

async function mergeConfigs(configs) {
    if (!configs || configs.length === 0) {
        throw new Error('没有有效的配置可供合并');
    }

    // 过滤掉无效的配置
    const validConfigs = configs.filter(config => 
        config && Array.isArray(config.proxies) && config.proxies.length > 0
    );

    if (validConfigs.length === 0) {
        throw new Error('没有包含代理节点的有效配置');
    }

    console.log(`找到 ${validConfigs.length} 个有效配置`);

    // 收集所有代理
    const allProxies = validConfigs.reduce((acc, config) => {
        if (Array.isArray(config.proxies)) {
            acc.push(...config.proxies);
        }
        return acc;
    }, []);

    // 删除重复的代理
    const uniqueProxies = Array.from(
        new Map(allProxies.map(proxy => [proxy.name, proxy])).values()
    );

    console.log(`合并了 ${uniqueProxies.length} 个代理节点`);

    // 创建全新的基础配置
    const mergedConfig = {
        port: 7890,
        'socks-port': 7891,
        'allow-lan': true,
        mode: 'rule',
        'log-level': 'info',
        proxies: uniqueProxies,
        'proxy-groups': [
            {
                name: '🚀 节点选择',
                type: 'select',
                proxies: uniqueProxies.map(proxy => proxy.name)
            }
        ],
        rules: ['MATCH,DIRECT']  // 使用最简单的规则
    };

    return mergedConfig;
}

async function processConfigs() {
    console.log('开始处理配置...');
    
    const urls = await readUrls();
    if (urls.length === 0) {
        console.log('没有找到有效的配置URL，请在clash-urls.txt中添加订阅链接');
        return;
    }

    console.log(`发现 ${urls.length} 个配置URL`);
    
    const configs = [];
    for (const url of urls) {
        console.log(`正在下载配置: ${url}`);
        const config = await downloadConfig(url);
        if (config) {
            configs.push(config);
        }
    }

    try {
        const mergedConfig = await mergeConfigs(configs);
        // 保存合并后的配置
        await fs.writeFile(OUTPUT_FILE, YAML.stringify(mergedConfig));
        console.log(`配置已合并并保存到: ${OUTPUT_FILE}`);
        console.log(`成功合并了 ${mergedConfig.proxies.length} 个代理节点`);
    } catch (err) {
        console.error('处理配置失败:', err.message);
    }
}

module.exports = {
    processConfigs,
    OUTPUT_FILE
};