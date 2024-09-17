import { defaultSettings, messageTypes } from './utils/constants.js';
import { getStorageData, setStorageData } from './utils/storage.js';

//Add context menu items and set default settings on install
const contextTypes = ['text', 'link', 'page', 'image'];

const createHashtagContextMenuItems = hashtags => {
    contextTypes.forEach(contextType => {
        chrome.contextMenus.create({
            id: `${contextType}-hashtag-parent`,
            title: `Send this ${contextType} with #hashtag`,
            contexts: [contextType === 'text' ? 'selection' : contextType]
        });

        hashtags.forEach((tag, index) => {
            chrome.contextMenus.create({
                id: `${contextType}-hashtag-${index}`,
                parentId: `${contextType}-hashtag-parent`,
                title: `#${tag}`,
                contexts: [contextType === 'text' ? 'selection' : contextType]
            });
        });
    });
};

const updateHashtagContextMenu = async () => {
    const options = await getStorageData('options');

    if (!options.hashtags || Object.keys(options.hashtags).length === 0) {
        options.hashtags = defaultSettings.hashtags;
        await setStorageData('options', options);
    }

    contextTypes.forEach(contextType => {
        chrome.contextMenus.remove(`${contextType}-hashtag-parent`, () => {
            if (chrome.runtime.lastError) {
                console.log(chrome.runtime.lastError.message);
            }
        });
    });

    if (options.hashtags.active) {
        createHashtagContextMenuItems(options.hashtags.setup[options.hashtags.use].tags);
    }
};

chrome.runtime.onInstalled.addListener(async details => {
    contextTypes.forEach(type =>
        chrome.contextMenus.create({
            id: type,
            title: `Send this ${type} to Telegram`,
            contexts: [type === 'text' ? 'selection' : type]
        })
    );

    //Set default settings if not set
    const options = await getStorageData('options');
    if (!options || Object.keys(options).length === 0) {
        await setStorageData('options', defaultSettings);
    }
    // Open the embed view after the extension is installed
    if (details.reason === 'install') {
        chrome.tabs.create({ url: '/pages/embed.html' });
    }

    if (!options.hashtags || Object.keys(options.hashtags).length === 0) {
        options.hashtags = defaultSettings.hashtags;
        await setStorageData('options', options);
    }

    const hashtags = options.hashtags.setup[options.hashtags.use].tags;
    createHashtagContextMenuItems(hashtags);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.options) {
      updateHashtagContextMenu();
    }
});

// Get the tab URL from the context menu click event, including PDF viewer
const parseTabUrl = async (click, tabUrl) => {
    if (!tabUrl.startsWith('http') && click.frameUrl.includes('.pdf')) {
        return click.frameUrl;
    }
    return tabUrl;
};

// Build the content data object by context menu click event and tab URL
const buildContentData = async (click, tabUrl) => {
    const baseMenuItemId = click.menuItemId.includes('-hashtag-')
        ? click.menuItemId.split('-')[0]
        : click.menuItemId;

    switch (baseMenuItemId) {
        case 'text':
            return { text: click.selectionText, tabUrl };
        case 'link':
            return { linkUrl: click.linkUrl, tabUrl };
        case 'page':
            return { pageUrl: tabUrl };
        case 'image':
            return { srcUrl: click.srcUrl, tabUrl };
        default:
            return false;
    }
};

// Get the file extension from the given URL string
const getFileExtension = function (url) {
    const path = new URL(url).pathname;
    if (!path.includes('.')) {
        return false;
    }
    return path.substring(path.lastIndexOf('.') + 1, path.length);
};

// Override the message type for certain file extensions to reach better results
const overrideMessageType = function (content, options) {
    if (options.actions.sendImage.sendAs === 'link') {
        return 'link';
    }
    const fileExtension = getFileExtension(content);
    switch (fileExtension) {
        case 'webp':
        case 'gif':
            return 'document';
        case 'svg':
            return 'link';
        default:
            return options.actions.sendImage.sendAs;
    }
};

// Listen for content from context menu and trigger sendMessage function
chrome.contextMenus.onClicked.addListener(async (click, tab) => {
    const options = await getStorageData('options');

    let baseMenuItemId = click.menuItemId;
    let hashtag = '';

    if (options.hashtags && options.hashtags.active && click.menuItemId.includes('-hashtag-')) {
        const itemParts = click.menuItemId.split('-');
        baseMenuItemId = itemParts[0];
        const hashtagIndex = Number(itemParts[2]);
        hashtag = options.hashtags.setup[options.hashtags.use].tags[hashtagIndex];
    }

    if (!contextTypes.includes(baseMenuItemId)) {
        return false;
    }

    const messageType = baseMenuItemId === 'image' ? overrideMessageType(click.srcUrl, options) : baseMenuItemId;
    const tabUrl = await parseTabUrl(click, tab.url);
    const messageData = await buildContentData(click, tabUrl);

    await sendMessage(messageData, messageType, tab, hashtag);
});

// Listen for connection status information request from homepage
chrome.runtime.onMessage.addListener(async request => {
    if (request.message === 'getConnectionStatus') {
        const options = await getStorageData('options');

        const botToken = options.connections.setup[options.connections.use].key;
        if (!botToken) {
            return await chrome.runtime.sendMessage({
                message: 'returnConnectionStatus',
                data: { ok: false, description: 'No token was provided.' }
            });
        }

        const requestURL = buildRequestURL('me', options);
        const getMe = await fetchAPI(requestURL, {});

        return await chrome.runtime.sendMessage({
            message: 'returnConnectionStatus',
            data: await getMe.json(),
        });
    }
});

//Function to check if given URL is valid
//Author @Pavlo https://stackoverflow.com/a/43467144
const isValidURL = function (string) {
    let url;
    try {
        url = new URL(string);
    } catch (_) {
        return false;
    }
    return url.protocol === 'http:' || url.protocol === 'https:';
};

// Get the Telegram Bot API method name by message type
const getMessageType = function (type) {
    switch (type) {
        case 'text':
        case 'link':
        case 'page':
            return '/sendMessage';
        case 'photo':
            return '/sendPhoto';
        case 'document':
            return '/sendDocument';
        case 'me':
            return '/getMe';
        default:
            return false;
    }
};

// Build the Telegram Bot API request URL by message type and active account
const buildRequestURL = function (type, options) {
    return 'https://api.telegram.org/bot' + options.connections.setup[options.connections.use].key + getMessageType(type);
};

// Build the message content object by message type
const buildContentByType = function (type, content) {
    switch (type) {
        case 'text':
            return { type: 'text', content: content.text };
        case 'link':
            if (!content.linkUrl && content.srcUrl) {
                content.linkUrl = content.srcUrl;
            }
            return { type: 'text', content: content.linkUrl };
        case 'page':
            return { type: 'text', content: content.pageUrl };
        case 'photo':
            return { type: 'photo', content: content.srcUrl };
        case 'document':
            return { type: 'document', content: content.srcUrl };
        default:
            return false;
    }
};

// Build the request parameters object by message type and user settings
const buildPostData = function (type, content, options, hashtag = '') {

    if (!messageTypes.includes(type)) {
        throw new Error(`Unrecognized message type: ${type}`);
    }

    const typeKey = `send${['photo', 'document'].includes(type) ? 'Image' : 'Message'}`;

    const parameters = {
        chat_id: options.connections.setup[options.connections.use].chatId,
        disable_notification: options.actions[typeKey].disableNotificationSound,
        disable_web_page_preview: options.actions[typeKey].disablePreview
    };

    const userContent = buildContentByType(type, content);

    if (['photo', 'document'].includes(type)) {
        userContent['type'] = overrideMessageType(userContent['content'], options);
    }

    parameters[userContent['type']] = userContent['content'];

    if (options.actions[typeKey].addSourceLink && isValidURL(content.tabUrl) && type !== 'page') {
        parameters.reply_markup = {
            inline_keyboard: [
                [{ text: 'Source', url: content.tabUrl }]
            ],
        };
    }

    if (options.hashtags && options.hashtags.active && hashtag) {
        if (['document', 'photo'].includes(type)) {
            parameters.caption = `#${hashtag}`;
        } else {
            parameters[userContent['type']] += ` #${hashtag}`;
        }
    }

    return parameters;
};

// Make HTTP requests using Fetch API
const fetchAPI = async function (url, postData) {
    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: postData ? JSON.stringify(postData) : undefined
    };
    try {
        return await fetch(url, options);
    } catch (error) {
        return JSON.stringify({ ok: false, description: `Error while sending the request: ${error}` });
    }
};

// Register the API response to the extension storage to use it later,
// and throw error with api response and stack trace if response is not ok
const handleAPIResponse = async function (data) {
    await setStorageData('lastAPIResponse', data);
    if (data.ok) {
        return true;
    }
    else {
        throw({
            status: data['error_code'],
            description: data.description,
            stackTrace: new Error()
        });
    }
};

// Register the message log to the extension storage to use it later,
// and increase the total message count if the message is sent successfully
const registerLog = async function (content, response, type, hashtag = '') {
    let logs = await getStorageData('messageLogs');
    let total = await getStorageData('totalMessageCount');
    const options = await getStorageData('options');
    if (options.logs.active) {
        if (!logs) {
            await setStorageData('messageLogs', []);
            logs = [];
        }
        if (!total) {
            await setStorageData('totalMessageCount', 0);
            total = 0;
        }
        logs.unshift(buildLogObject(content, response, type, options, hashtag));
        await setStorageData('messageLogs', logs);
    }
    if (response.ok) {
        await setStorageData('totalMessageCount', total + 1);
    }
};

const getFileIDsFromResponse = function (result) {
    let type = '';
    ['photo', 'document', 'sticker'].forEach(key => result[key] ? type = key : null);
    const uploadedFile = Array.isArray(result[type]) ? result[type].at(-1) : result[type];
    return {
        fileID: uploadedFile['file_id'],
        uniqueID: uploadedFile['file_unique_id']
    };
};

// Build the log object by message type and user settings
const buildLogObject = function (content, response, type, options, hashtag = '') {
    if (!response.ok) {
        return { type: type, content: false, errorLog: response, timestamp: Date.now(), status: 'fail' };
    }
    else if (options.logs.type === 'timestamp') {
        return { type: type, content: false, timestamp: Date.now(), status: 'success', hashtag };
    }
    else if (options.logs.type === 'everything') {
        const contentObject = ['photo', 'document'].includes(type) ? {
            ...content,
            ...getFileIDsFromResponse(response.result)
        } : content;
        return { type: type, content: contentObject, timestamp: Date.now(), status: 'success', hashtag };
    }
    else {
        return false;
    }
};

// Show status badge on the extension's icon,
// and clear it after 1.5 seconds if the message is sent successfully
const handleBadgeText = async function (success) {
    if (typeof success !== 'boolean') {
        return false;
    }

    await chrome.action.setBadgeText({ text: success ? 'Sent' : 'Fail' });
    await chrome.action.setBadgeBackgroundColor({ color: success ? '#008000bd' : '#880024' });

    if (success) {
        setTimeout(async () => {
            await chrome.action.setBadgeText({ text: '' });
        }, 1500);
    }
};

// Send the message to Telegram Bot API and handle the response
const sendMessage = async function (content, type, tab, hashtag = '') {
    try {
        if (!content || !messageTypes.includes(type)) {
            throw new Error('sendMessage parameters are not valid!');
        }
        // Build the request parameters and message object
        const options = await getStorageData('options');
        const requestURL = buildRequestURL(type, options);
        const requestParameters = buildPostData(type, content, options, hashtag);
        const activeAccount = options.connections.setup[options.connections.use];
        // Check if the Bot API key and chat ID are set
        if (!activeAccount.key || !activeAccount.chatId) {
            return await handleAPIResponse({
                ok: false,
                description: 'Please set up your Telegram bot token and chat ID to start sending messages.'
            });
        }
        // Send the request to Telegram Bot API
        const sendRequest = await fetchAPI(requestURL, requestParameters);
        const response = await sendRequest.json();
        // Register the API response to the extension storage to use it later
        return await handleAPIResponse(response);
    } catch (error) {
        console.error('Error while sending the message: ', error);
        // TODO: Handle pre-message errors
    } finally {
        // Read the API response and then clear its value
        const apiResponse = await getStorageData('lastAPIResponse');
        await setStorageData('lastAPIResponse', {});
        // Show status badge on the extension's icon
        await handleBadgeText(apiResponse.ok);
        // If the browser is not in Incognito Mode, register the message log
        if (!tab.incognito) {
            await registerLog(content, apiResponse, type, hashtag);
        }
    }
};
