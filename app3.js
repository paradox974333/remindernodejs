// WhatsApp Reminder Bot with AI Assistant using Meta's Official WhatsApp Business API
// Requirements: npm install express axios node-cron fs path dotenv

const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json()); // Middleware to parse JSON bodies

// --- Constants ---
const WHATSAPP_API_VERSION = 'v19.0'; // Use a recent, stable API version
const DATA_DIR = path.join(__dirname, 'data');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const PROFILES_FILE = path.join(DATA_DIR, 'userProfiles.json');
const DEFAULT_SNOOZE_MINUTES = 10;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const OPENROUTER_TIMEOUT_MS = 15000; // 15 seconds
const MAX_AI_RESPONSE_TOKENS = 120; // Adjusted for conciseness
const DEFAULT_REMINDER_TIME_MORNING = { hour: 9, minute: 0 };
const DEFAULT_REMINDER_TIME_EVENING = { hour: 20, minute: 0 };

// --- Configuration from environment variables ---
// Critical configurations - application might not work without these
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// AI Assistant configurations
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';
const SITE_URL = process.env.SITE_URL || 'https://your-app.com'; // Used for OpenRouter Referer
const SITE_NAME = process.env.SITE_NAME || 'WhatsApp Reminder Pal'; // Used for OpenRouter X-Title

// --- Global State ---
let reminders = []; // Array of reminder objects
let userSessions = {}; // Ephemeral session data for multi-step interactions
let userProfiles = {}; // Persistent user data

// --- Utility Functions ---
/**
 * Formats a Date object into a user-friendly string.
 * TODO: Implement user-specific timezone preferences.
 * @param {Date} date The date to format.
 * @param {string} [locale='en-US'] The locale to use for formatting.
 * @returns {string} Formatted date string.
 */
function formatDateForDisplay(date, locale = 'en-US') {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
        return 'Invalid Date';
    }
    // For now, uses server's locale. Ideally, this would use user's preferred timezone.
    return date.toLocaleString(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

// --- Data Persistence ---
// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log(`Data directory created: ${DATA_DIR}`);
    } catch (error) {
        console.error(`FATAL: Could not create data directory ${DATA_DIR}. Exiting.`, error);
        process.exit(1);
    }
}

/**
 * Loads reminders and user profiles from JSON files.
 * Handles potential parsing errors by backing up corrupted files.
 */
function loadData() {
    const loadFile = (filePath, defaultData) => {
        if (fs.existsSync(filePath)) {
            const rawData = fs.readFileSync(filePath, 'utf8');
            if (rawData.trim() === '') return defaultData; // Handle empty file
            try {
                const parsedData = JSON.parse(rawData);
                // Convert ISO date strings back to Date objects
                if (filePath === REMINDERS_FILE) {
                    return parsedData.map(r => ({
                        ...r,
                        triggerTime: r.triggerTime ? new Date(r.triggerTime) : null,
                        created: r.created ? new Date(r.created) : null,
                    }));
                }
                if (filePath === PROFILES_FILE) {
                    return Object.fromEntries(
                        Object.entries(parsedData).map(([key, profile]) => [
                            key,
                            {
                                ...profile,
                                joinedAt: profile.joinedAt ? new Date(profile.joinedAt) : null,
                            },
                        ])
                    );
                }
                return parsedData;
            } catch (parseError) {
                console.error(`Error parsing ${filePath}. Backing up and starting fresh for this file.`, parseError);
                const backupFile = path.join(DATA_DIR, `${path.basename(filePath)}.corrupted.${new Date().toISOString().replace(/:/g, '-')}`);
                try {
                    fs.copyFileSync(filePath, backupFile);
                    console.warn(`Backed up corrupted file to ${backupFile}`);
                } catch (backupError) {
                    console.error(`Failed to backup corrupted file ${filePath}:`, backupError);
                }
                return defaultData;
            }
        }
        return defaultData;
    };

    reminders = loadFile(REMINDERS_FILE, []);
    userProfiles = loadFile(PROFILES_FILE, {});
    console.log(`Loaded ${reminders.length} reminders and ${Object.keys(userProfiles).length} user profiles.`);
}

/**
 * Saves reminders and user profiles to JSON files atomically.
 * Writes to a temporary file first, then renames to avoid data corruption.
 */
function saveData() {
    const saveFile = (filePath, data) => {
        const tempFilePath = `${filePath}.tmp`;
        try {
            let serializableData;
            if (filePath === REMINDERS_FILE) {
                serializableData = data.map(r => ({
                    ...r,
                    triggerTime: r.triggerTime instanceof Date ? r.triggerTime.toISOString() : r.triggerTime,
                    created: r.created instanceof Date ? r.created.toISOString() : r.created,
                }));
            } else if (filePath === PROFILES_FILE) {
                serializableData = Object.fromEntries(
                    Object.entries(data).map(([key, profile]) => [
                        key,
                        {
                            ...profile,
                            joinedAt: profile.joinedAt instanceof Date ? profile.joinedAt.toISOString() : profile.joinedAt,
                        },
                    ])
                );
            } else {
                serializableData = data;
            }

            fs.writeFileSync(tempFilePath, JSON.stringify(serializableData, null, 2), 'utf8');
            fs.renameSync(tempFilePath, filePath); // Atomic operation on most systems
        } catch (error) {
            console.error(`Error saving data to ${filePath}:`, error);
            if (fs.existsSync(tempFilePath)) {
                try {
                    fs.unlinkSync(tempFilePath); // Clean up temp file on error
                } catch (cleanupError) {
                    console.error(`Error cleaning up temp file ${tempFilePath}:`, cleanupError);
                }
            }
        }
    };

    saveFile(REMINDERS_FILE, reminders);
    saveFile(PROFILES_FILE, userProfiles);
    // console.log('Data saved successfully.'); // Can be too noisy, log on change or less frequently
}

// --- WhatsApp API Integration ---
/**
 * Sends a text message via WhatsApp API.
 * @param {string} phoneNumber User's phone number.
 * @param {string} message Text message to send.
 * @returns {Promise<void>}
 */
async function sendWhatsAppMessage(phoneNumber, message) {
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error('WhatsApp credentials not configured. Cannot send message.');
        return;
    }
    try {
        await axios.post(
            `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'text',
                text: { body: message },
            },
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
    } catch (error) {
        console.error(`Error sending WhatsApp message to ${phoneNumber}:`, error.response?.data || error.message);
        // Implement retry logic or dead-letter queue for critical messages if needed
    }
}

/**
 * Sends an interactive message with buttons via WhatsApp API.
 * @param {string} phoneNumber User's phone number.
 * @param {string} text Message body.
 * @param {Array<{id: string, title: string}>} buttons Array of button objects.
 * @returns {Promise<void>}
 */
async function sendInteractiveWhatsAppMessage(phoneNumber, text, buttons) {
    if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error('WhatsApp credentials not configured. Cannot send interactive message.');
        // Fallback to text message
        await sendWhatsAppMessage(phoneNumber, `${text}\n(Interactive options unavailable)`);
        return;
    }
    if (buttons.some(btn => btn.title.length > 24 || btn.id.length > 256)) {
        console.error('Interactive message button constraints violated (title > 24 chars or id > 256 chars). Sending as text.');
        let fallbackMessage = text;
        buttons.forEach(btn => fallbackMessage += `\n- ${btn.title}`);
        await sendWhatsAppMessage(phoneNumber, fallbackMessage);
        return;
    }
    try {
        await axios.post(
            `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: phoneNumber,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: text },
                    action: {
                        buttons: buttons.map(btn => ({
                            type: 'reply',
                            reply: { id: btn.id, title: btn.title },
                        })),
                    },
                },
            },
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
    } catch (error) {
        console.error(`Error sending interactive WhatsApp message to ${phoneNumber}:`, error.response?.data || error.message);
        let fallbackMessage = text;
        buttons.forEach(btn => fallbackMessage += `\n- ${btn.title} (Option ID: ${btn.id})`); // Provide ID for manual action if user wants
        await sendWhatsAppMessage(phoneNumber, fallbackMessage + "\n(Could not display buttons, please reply with text if needed or try command again)");
    }
}

// --- AI Assistant (OpenRouter) ---
/**
 * Gets a response from OpenRouter AI.
 * @param {string} userMessage The user's message.
 * @param {object} userContext Additional context about the user.
 * @returns {Promise<string>} AI-generated response or fallback.
 */
async function getAIResponse(userMessage, userContext = {}) {
    if (!OPENROUTER_API_KEY) {
        console.warn('OpenRouter API key not configured. Using fallback response for AI query.');
        return getFallbackAIResponse(userMessage);
    }
    try {
        const systemPrompt = `You are a friendly and concise WhatsApp assistant for "${SITE_NAME}".
        Keep responses brief (around 1-2 sentences, max ~250 characters).
        Available commands: @remind, @list, @cancel, @stats, @help.
        User context: ${JSON.stringify(userContext)}.
        Current date: ${new Date().toDateString()}`;

        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model: OPENROUTER_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
                max_tokens: MAX_AI_RESPONSE_TOKENS,
                temperature: 0.7,
                // stop: ["\n"], // Can help enforce brevity for some models
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': SITE_URL,
                    'X-Title': SITE_NAME,
                },
                timeout: OPENROUTER_TIMEOUT_MS,
            }
        );
        return response.data.choices[0]?.message?.content?.trim() || 'I apologize, I had a little trouble thinking. Could you rephrase?';
    } catch (error) {
        console.error('OpenRouter API error:', error.response?.data || error.message);
        return getFallbackAIResponse(userMessage);
    }
}

/**
 * Provides a fallback response if AI service fails.
 * @param {string} message User's message.
 * @returns {string} A predefined or simple rule-based response.
 */
function getFallbackAIResponse(message) {
    const lowerMessage = message.toLowerCase();
    const commonGreetings = ['hello', 'hi', 'hey', 'good morning', 'good evening'];
    if (commonGreetings.some(g => lowerMessage.includes(g))) return 'Hello! How can I assist you today? Try "help" for commands.';
    if (lowerMessage.includes('thank')) return "You're welcome! 😊";
    if (lowerMessage.includes('bye')) return 'Goodbye! 👋';
    return "I can help set reminders or answer simple questions. Try 'remind me to call Mom tomorrow' or ask 'help'.";
}

// --- Reminder Parsing Logic (NLP) ---
/**
 * Parses reminder text to extract message, trigger time, and recurrence.
 * This is a complex area; for true "perfection," a dedicated NLP library like chrono-node is recommended.
 * This version enhances the regex-based approach.
 * @param {string} text The full reminder command text.
 * @param {string} [userTimezone='UTC'] User's timezone (IANA format, e.g., 'America/New_York'). Not fully implemented, uses server time.
 * @returns {object|null} Parsed reminder object or null if parsing fails.
 */
function parseReminderText(text, userTimezone = 'UTC') {
    // TODO: Full timezone support requires a library like 'date-fns-tz' or 'moment-timezone'
    // For now, operations are based on server's local time interpretation of ambiguous inputs.
    // Storing Dates as UTC is good practice, achieved by new Date(isoString).

    let originalText = text;
    let processedText = text.toLowerCase().replace(/^(?:@remind\s+|remind\s+me\s+(?:to\s+)?)/i, '').trim();
    if (!processedText) return null; // No actual content after "remind me to"

    const reminder = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`, // Shorter, still highly unique
        originalText: originalText,
        message: '',
        triggerTime: null, // Date object
        recurring: false,
        pattern: null, // e.g., 'daily', 'weekly_monday'
        active: true,
        completed: false,
        snoozed: false,
        created: new Date(),
    };

    const now = new Date();
    let tempTriggerTime = new Date(now); // Base for relative calculations
    let datePartsSet = { year: false, month: false, day: false, dayOfWeek: false };
    let timePartsSet = { hour: false, minute: false };

    // Regex patterns (refined and ordered)
    // Note: Order matters. More specific or overriding patterns should be tested carefully.
    const patterns = {
        // Recurring patterns
        daily: { regex: /\b(every\s+day|daily)\b/i, handler: () => {
            reminder.recurring = true; reminder.pattern = 'daily';
            if (!timePartsSet.hour) tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_MORNING.hour, DEFAULT_REMINDER_TIME_MORNING.minute, 0, 0);
            if (tempTriggerTime <= now) tempTriggerTime.setDate(tempTriggerTime.getDate() + 1);
        }},
        weekly: { regex: /\b(every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekly)\b/i, handler: (match) => {
            reminder.recurring = true;
            const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            let targetDay = match[2] ? days.indexOf(match[2].toLowerCase()) : tempTriggerTime.getDay();
            reminder.pattern = `weekly_${days[targetDay]}`;
            if (!timePartsSet.hour) tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_MORNING.hour, DEFAULT_REMINDER_TIME_MORNING.minute, 0, 0);
            let daysToAdd = (targetDay - tempTriggerTime.getDay() + 7) % 7;
            if (daysToAdd === 0 && tempTriggerTime <= now) daysToAdd = 7; // If today but time passed or same day, next week
            else if (daysToAdd === 0 && !timePartsSet.hour && tempTriggerTime.getHours() < DEFAULT_REMINDER_TIME_MORNING.hour) {
                // today, default time, not yet passed - it's for today
            } else if (daysToAdd === 0 && tempTriggerTime <= now) {
                 daysToAdd = 7; // for today but time passed
            }


            tempTriggerTime.setDate(tempTriggerTime.getDate() + daysToAdd);
            datePartsSet.dayOfWeek = true;
        }},
        monthly: { regex: /\b(every\s+month)(?:\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?)?\b/i, handler: (match) => {
            reminder.recurring = true; reminder.pattern = 'monthly';
            let dayOfMonth = match[2] ? parseInt(match[2]) : tempTriggerTime.getDate();
            if (!timePartsSet.hour) tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_MORNING.hour, DEFAULT_REMINDER_TIME_MORNING.minute, 0, 0);
            tempTriggerTime.setDate(dayOfMonth);
            if (tempTriggerTime <= now) tempTriggerTime.setMonth(tempTriggerTime.getMonth() + 1);
            datePartsSet.day = true;
        }},
        // Specific time of day (e.g., "at 5pm", "at 10:30")
        specificTime: { regex: /\b(?:at|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i, handler: (match) => {
            let hours = parseInt(match[1]);
            const minutes = match[2] ? parseInt(match[2]) : 0;
            const ampm = match[3] ? match[3].toLowerCase() : null;
            if (ampm === 'pm' && hours >= 1 && hours <= 11) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0; // 12 AM (midnight)
            if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return; // Invalid time

            tempTriggerTime.setHours(hours, minutes, 0, 0);
            timePartsSet.hour = true; timePartsSet.minute = true;
        }},
        // Relative times ("in X minutes/hours/days")
        inRelative: { regex: /\b(?:in|after)\s+(\d+)\s+(minute|min|hour|hr|day|week)s?\b/i, handler: (match) => {
            const value = parseInt(match[1]);
            const unit = match[2].startsWith('min') ? 'minute' : match[2].startsWith('hr') ? 'hour' : match[2].startsWith('day') ? 'day' : 'week';
            if (unit === 'minute') tempTriggerTime.setMinutes(tempTriggerTime.getMinutes() + value);
            else if (unit === 'hour') tempTriggerTime.setHours(tempTriggerTime.getHours() + value);
            else if (unit === 'day') tempTriggerTime.setDate(tempTriggerTime.getDate() + value);
            else if (unit === 'week') tempTriggerTime.setDate(tempTriggerTime.getDate() + value * 7);
            datePartsSet.day = true; timePartsSet.hour = true; // Relative time sets both
        }},
        // Keywords like "tomorrow", "tonight", "today"
        tomorrow: { regex: /\btomorrow\b/i, handler: () => {
            tempTriggerTime.setDate(now.getDate() + 1);
            if (!timePartsSet.hour) tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_MORNING.hour, DEFAULT_REMINDER_TIME_MORNING.minute, 0, 0);
            datePartsSet.day = true;
        }},
        tonight: { regex: /\btonight\b/i, handler: () => {
            tempTriggerTime.setDate(now.getDate()); // Ensure it's today
            if (!timePartsSet.hour) tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_EVENING.hour, DEFAULT_REMINDER_TIME_EVENING.minute, 0, 0);
            if (tempTriggerTime <= now) { // If evening time already passed for today
                 tempTriggerTime.setDate(now.getDate() + 1); // Move to tomorrow same evening time (less common interpretation)
                 // Or, user might mean "later tonight if possible". This is ambiguous. Current: move to next day.
            }
            datePartsSet.day = true;
        }},
        today: { regex: /\btoday\b/i, handler: () => { // "today at 5pm"
            tempTriggerTime.setDate(now.getDate());
            if (!timePartsSet.hour) { // If no specific time given with "today", default to 1 hour from now or standard morning time
                let proposedTime = new Date(now.getTime() + 60*60*1000); // 1 hour from now
                if(proposedTime.getHours() < DEFAULT_REMINDER_TIME_MORNING.hour) {
                    tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_MORNING.hour, DEFAULT_REMINDER_TIME_MORNING.minute, 0, 0);
                } else {
                    tempTriggerTime.setHours(proposedTime.getHours(), proposedTime.getMinutes(),0,0);
                }
            }
            datePartsSet.day = true;
        }},
        // Specific dates ("on July 4th", "on 15th December")
        specificDate: { regex: /\b(?:on\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/i, handler: (match) => {
            const monthNames = {jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11};
            const month = monthNames[match[1].substring(0,3).toLowerCase()];
            const day = parseInt(match[2]);
            const year = match[3] ? parseInt(match[3]) : now.getFullYear();

            tempTriggerTime.setFullYear(year, month, day);
            if (!timePartsSet.hour) tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_MORNING.hour, DEFAULT_REMINDER_TIME_MORNING.minute, 0, 0);
            if (tempTriggerTime.getFullYear() === now.getFullYear() && tempTriggerTime < now && !match[3]) { // If no year specified and date is past, assume next year
                tempTriggerTime.setFullYear(year + 1);
            }
            datePartsSet.year = true; datePartsSet.month = true; datePartsSet.day = true;
        }},
         specificDateAlt: { regex: /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,\s*(\d{4}))?\b/i, handler: (match) => { // "15th December"
            const monthNames = {jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11};
            const day = parseInt(match[1]);
            const month = monthNames[match[2].substring(0,3).toLowerCase()];
            const year = match[3] ? parseInt(match[3]) : now.getFullYear();

            tempTriggerTime.setFullYear(year, month, day);
            if (!timePartsSet.hour) tempTriggerTime.setHours(DEFAULT_REMINDER_TIME_MORNING.hour, DEFAULT_REMINDER_TIME_MORNING.minute, 0, 0);
             if (tempTriggerTime.getFullYear() === now.getFullYear() && tempTriggerTime < now && !match[3]) {
                tempTriggerTime.setFullYear(year + 1);
            }
            datePartsSet.year = true; datePartsSet.month = true; datePartsSet.day = true;
        }},
        // TODO: Add more patterns like "next monday", "this weekend"
    };

    let messageContent = processedText;
    const timePhrasesFound = [];

    // Apply patterns: iterate multiple times or in specific order for complex interactions
    // This order attempts to build date then time, then adjust.
    // Recurring patterns usually establish a base cadence.
    for (const key of ['daily', 'weekly', 'monthly']) { // Recurring first
        const pattern = patterns[key];
        const match = messageContent.match(pattern.regex);
        if (match) {
            pattern.handler(match);
            timePhrasesFound.push(match[0]);
            // messageContent = messageContent.replace(match[0], '').trim(); // Remove phrase
        }
    }
    for (const key of ['tomorrow', 'tonight', 'today', 'specificDate', 'specificDateAlt']) { // Specific days/dates
        const pattern = patterns[key];
        const match = messageContent.match(pattern.regex);
        if (match) {
            pattern.handler(match);
            timePhrasesFound.push(match[0]);
            // messageContent = messageContent.replace(match[0], '').trim();
        }
    }
     for (const key of ['inRelative', 'specificTime']) { // Relative and specific times
        const pattern = patterns[key];
        const match = messageContent.match(pattern.regex);
        if (match) {
            pattern.handler(match);
            timePhrasesFound.push(match[0]);
            // messageContent = messageContent.replace(match[0], '').trim();
        }
    }

    // Refine message content by removing identified time phrases
    // Sort by length descending to remove longer phrases first (e.g., "tomorrow at 5pm" before "tomorrow" or "at 5pm")
    timePhrasesFound.sort((a,b) => b.length - a.length);
    timePhrasesFound.forEach(phrase => {
        // Use a regex to remove the phrase, being careful about word boundaries or context
        // This is still tricky; simply replacing might break meaning if phrase is part of task
        // For now, a simpler replace:
        messageContent = messageContent.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim();
    });
    // Remove extra spaces that might result from replacements
    messageContent = messageContent.replace(/\s\s+/g, ' ').trim();


    reminder.message = messageContent || "Untitled Reminder"; // If all text was time phrases

    // If only time was specified (e.g., "remind me at 5pm"), and it's past for today, advance to next day
    if (timePartsSet.hour && !datePartsSet.day && !datePartsSet.month && !datePartsSet.year && !reminder.recurring) {
        if (tempTriggerTime <= now) {
            tempTriggerTime.setDate(tempTriggerTime.getDate() + 1);
        }
    }

    // If no date/time components were parsed at all, it's not a valid reminder time
    if (!timePartsSet.hour && !datePartsSet.day && !datePartsSet.month && !datePartsSet.year && !reminder.recurring && !processedText.match(patterns.inRelative.regex)) {
         // Check if *any* time component was found. If not, it's invalid.
        if (!timePhrasesFound.length) return null;
        // If some phrases were found but didn't set time (e.g. malformed), also potentially invalid.
        // This simple check might not be enough.
        // Heuristic: If we parsed something but tempTriggerTime is still effectively 'now', it likely failed.
        if (Math.abs(tempTriggerTime.getTime() - now.getTime()) < 60000 && !reminder.recurring) { // If time is within a minute of now and not recurring
            // It could be an "in 0 minutes" type case or a parse failure.
            // A more robust check is if any date/time part was explicitly set.
            let explicitTimeSet = Object.values(datePartsSet).some(v => v) || Object.values(timePartsSet).some(v => v);
            if (!explicitTimeSet && !reminder.recurring) return null;
        }
    }
    
    // Ensure final trigger time is in the future for non-recurring reminders
    if (!reminder.recurring && tempTriggerTime <= now) {
        // This case should be rare if above logic is correct, but as a fallback:
        // If it's for today and time passed, move to tomorrow same time.
        if (tempTriggerTime.toDateString() === now.toDateString()) {
             tempTriggerTime.setDate(tempTriggerTime.getDate() + 1);
        } else {
            // If it's a past date/time for some other reason, this reminder is invalid as non-recurring.
            // Or, it's a misparsed "in X units" that resulted in past.
            // For simplicity here, we'll assume the user wants it at the next available slot.
            // But this could be an error. For "perfect", this needs careful thought.
            // console.warn(`Non-recurring reminder ${reminder.id} resolved to past time: ${tempTriggerTime}. Forcing future.`);
            // A simple fix: if it's in the past and not recurring, it's probably a mistake or needs specific handling.
            // For now, let's allow it if it was explicitly set to a past date (e.g. user error).
            // The cron job won't pick it up if it's already past.
            // However, typical user intent is for future.
            // The `if (tempTriggerTime <= now)` check after `specificTime` and `today` handlers aims to fix this.
            // If it's still in the past, maybe it was "remind me yesterday" which is invalid.
             if (tempTriggerTime.getTime() < now.getTime() - 60000) { // Allow for small processing delays
                 console.warn(`Parsed non-recurring reminder for the past: ${tempTriggerTime.toISOString()}. Text: ${originalText}`);
                 return null; // Invalid reminder
             }
        }
    }

    reminder.triggerTime = tempTriggerTime;
    return reminder;
}


// --- Session Management ---
/**
 * Initializes or updates a user session.
 * @param {string} phoneNumber User's phone number.
 * @returns {object} The user's session object.
 */
function initializeUserSession(phoneNumber) {
    if (!userSessions[phoneNumber]) {
        userSessions[phoneNumber] = {
            state: 'idle', // e.g., 'awaiting_cancel_confirmation'
            lastActivity: new Date(),
            // context: {}, // For storing temporary data for multi-turn interactions
        };
    } else {
        userSessions[phoneNumber].lastActivity = new Date();
    }
    return userSessions[phoneNumber];
}

// --- Core Message Processing Logic ---
/**
 * Processes an incoming message from a user.
 * @param {string} phoneNumber User's phone number.
 * @param {string} messageContent Text content of the message.
 * @param {string} [messageType='text'] Type of message ('text', 'interactive').
 * @param {string|null} [buttonPayload=null] Payload from button click if any.
 * @returns {Promise<void>}
 */
async function processMessage(phoneNumber, messageContent, messageType = 'text', buttonPayload = null) {
    const session = initializeUserSession(phoneNumber);
    const lowerMessage = messageContent.toLowerCase();

    // Onboarding for new users
    if (!userProfiles[phoneNumber]) {
        userProfiles[phoneNumber] = {
            phoneNumber: phoneNumber,
            firstName: 'Friend', // TODO: Get from WhatsApp profile if API allows and user consents
            joinedAt: new Date(),
            totalReminders: 0,
            activeReminders: 0,
            completedReminders: 0,
            preferences: { timezone: 'UTC' }, // Default, placeholder for future use
        };
        saveData(); // Save new profile
        await sendWhatsAppMessage(phoneNumber,
            `🎉 Welcome to ${SITE_NAME}!\n\n` +
            `I'm your personal reminder assistant. I can help you with:\n` +
            `📝 Smart reminders (e.g., "remind me to call mom tomorrow at 6 PM")\n` +
            `🤖 Answering your questions\n\n` +
            `Key commands:\n` +
            `• "@remind [task] [time]"\n` +
            `• "@list" - view active reminders\n` +
            `• "@cancel" - manage cancellations\n` +
            `• "@stats" - your reminder stats\n` +
            `• "help" - for more info\n\n` +
            `How can I assist you first? 😊`
        );
        return;
    }

    // Handle interactive button responses
    if (messageType === 'interactive' && buttonPayload) {
        return handleButtonResponse(phoneNumber, buttonPayload, session);
    }

    // Command processing
    if (lowerMessage.startsWith('@remind') || lowerMessage.startsWith('remind me')) {
        await handleSetReminder(phoneNumber, messageContent);
    } else if (lowerMessage.startsWith('@list') || lowerMessage.includes('show reminders') || lowerMessage.includes('my reminders')) {
        await handleListReminders(phoneNumber);
    } else if (lowerMessage.startsWith('@cancel')) {
        await handleCancelReminderFlow(phoneNumber, session);
    } else if (lowerMessage.includes('@stats') || lowerMessage.includes('statistics')) {
        await handleShowStats(phoneNumber);
    } else if (lowerMessage.includes('@help') || lowerMessage === '?') {
        await handleHelp(phoneNumber);
    } else { // Fallback to AI for non-command messages
        const userContext = {
            profile: {
                totalReminders: userProfiles[phoneNumber]?.totalReminders || 0,
                activeReminders: reminders.filter(r => r.phoneNumber === phoneNumber && r.active).length,
                joinedAt: userProfiles[phoneNumber]?.joinedAt?.toISOString(),
            },
            currentTime: new Date().toISOString(),
        };
        const aiResponse = await getAIResponse(messageContent, userContext);
        await sendWhatsAppMessage(phoneNumber, aiResponse);
    }
}

// --- Command Handlers (called by processMessage) ---

async function handleButtonResponse(phoneNumber, buttonPayload, session) {
    const parts = buttonPayload.split('_'); // e.g., confirm_cancellation_all, completed_reminder_12345
    const action = parts[0];
    const targetType = parts[1];
    const identifier = parts.slice(2).join('_');

    if (targetType === 'cancellation' && identifier === 'all') {
        if (action === 'confirm') {
            const userActiveReminders = reminders.filter(r => r.phoneNumber === phoneNumber && r.active);
            const cancelCount = userActiveReminders.length;
            if (cancelCount > 0) {
                reminders = reminders.filter(r => !(r.phoneNumber === phoneNumber && r.active));
                if (userProfiles[phoneNumber]) userProfiles[phoneNumber].activeReminders = 0;
                saveData();
                await sendWhatsAppMessage(phoneNumber, `🗑️ All ${cancelCount} active reminders have been cancelled.`);
            } else {
                await sendWhatsAppMessage(phoneNumber, '👍 No active reminders to cancel.');
            }
        } else if (action === 'decline') {
            await sendWhatsAppMessage(phoneNumber, '👍 Okay, your reminders are safe.');
        }
        session.state = 'idle';
    } else if (targetType === 'reminder') {
        const reminder = reminders.find(r => r.id === identifier);
        if (reminder) {
            if (action === 'completed') {
                reminder.active = false;
                reminder.completed = true;
                if (userProfiles[phoneNumber]) {
                    userProfiles[phoneNumber].completedReminders = (userProfiles[phoneNumber].completedReminders || 0) + 1;
                    // Active reminders count was already reduced when it fired (for one-time) or will be handled if recurring
                }
                saveData();
                await sendWhatsAppMessage(phoneNumber, `✅ Great job! Marked "${reminder.message}" as completed.\nKeep up the good work! 🎉`);
            } else if (action === 'snooze') {
                const snoozeTime = new Date(Date.now() + DEFAULT_SNOOZE_MINUTES * 60000);
                reminder.triggerTime = snoozeTime;
                reminder.snoozed = true;
                reminder.active = true; // Ensure it's active if snoozed
                // If it was a one-time reminder that became inactive after firing, snoozing reactivates it.
                // Profile's activeReminders count should reflect this.
                if (userProfiles[phoneNumber] && !reminders.find(r => r.id === identifier && r.active === false)) {
                     // This logic can be tricky. If it was already active, count doesn't change. If it became inactive and is now snoozed (active again), increment.
                     // The cron job sets one-time reminders to inactive. So snoozing should make it active again.
                     // This assumes that userProfiles[phoneNumber].activeReminders was decremented when it first fired.
                    // Let's ensure the cron job properly handles decrementing and this action correctly increments if it was inactive.
                    // For simplicity, let's assume activeReminders reflects true state from `reminders` array at points of calculation (like @list, @stats)
                }
                saveData();
                await sendWhatsAppMessage(phoneNumber, `😴 Snoozed "${reminder.message}" for ${DEFAULT_SNOOZE_MINUTES} minutes. I'll remind you again around ${formatDateForDisplay(snoozeTime)}.`);
            }
        } else {
            await sendWhatsAppMessage(phoneNumber, "Hmm, I couldn't find that reminder. It might have been processed or removed.");
        }
    } else {
        console.warn(`Unhandled interactive button from ${phoneNumber}: ${buttonPayload}`);
        await sendWhatsAppMessage(phoneNumber, "I'm sorry, I didn't understand that action.");
    }
}

async function handleSetReminder(phoneNumber, messageContent) {
    const reminderData = parseReminderText(messageContent); // TODO: Pass user timezone from profile
    if (reminderData && reminderData.triggerTime && reminderData.message) {
        reminderData.phoneNumber = phoneNumber;
        // ID, created, active are set by parseReminderText or by default
        reminders.push(reminderData);
        if (userProfiles[phoneNumber]) {
            userProfiles[phoneNumber].totalReminders = (userProfiles[phoneNumber].totalReminders || 0) + 1;
            userProfiles[phoneNumber].activeReminders = (userProfiles[phoneNumber].activeReminders || 0) + 1;
        }
        saveData();

        const timeStr = formatDateForDisplay(reminderData.triggerTime);
        const recurringStr = reminderData.recurring ? ` (Repeats ${reminderData.pattern.replace('_', ' ')})` : '';
        const emoji = reminderData.recurring ? '🔄' : '⏰';

        await sendWhatsAppMessage(phoneNumber,
            `✅ Reminder set!\n\n` +
            `📝 Task: ${reminderData.message}\n` +
            `${emoji} Time: ${timeStr}${recurringStr}\n\n` +
            `I'll notify you! 🔔`
        );
    } else {
        await sendWhatsAppMessage(phoneNumber,
            `❌ Oops! I couldn't understand that reminder. Can you try phrasing it clearly?\n\n` +
            `Examples:\n` +
            `• "@remind drink water in 30 minutes"\n` +
            `• "remind me to call mom tomorrow at 6 PM"\n` +
            `• "@remind project update every friday at 10am"\n\n` +
            `Or type "help" for more examples.`
        );
    }
}

async function handleListReminders(phoneNumber) {
    const userActiveReminders = reminders.filter(r => r.phoneNumber === phoneNumber && r.active);
    if (userActiveReminders.length === 0) {
        await sendWhatsAppMessage(phoneNumber, `📋 You have no active reminders. Create one with "@remind [task] [time]".`);
    } else {
        let reminderList = `📋 Your Active Reminders (${userActiveReminders.length}):\n\n`;
        userActiveReminders.sort((a, b) => a.triggerTime.getTime() - b.triggerTime.getTime());
        userActiveReminders.forEach((r, index) => {
            const timeStr = formatDateForDisplay(r.triggerTime);
            const recurringIcon = r.recurring ? '🔄' : '⏰';
            const snoozeIcon = r.snoozed ? '😴' : '';
            reminderList += `${index + 1}. ${r.message}\n   ${recurringIcon} ${timeStr} ${snoozeIcon}\n\n`; // Consider adding reminder ID for specific cancel
        });
        await sendWhatsAppMessage(phoneNumber, reminderList.trim());
    }
}

async function handleCancelReminderFlow(phoneNumber, session) {
    const userActiveRemindersCount = reminders.filter(r => r.phoneNumber === phoneNumber && r.active).length;
    if (userActiveRemindersCount === 0) {
        await sendWhatsAppMessage(phoneNumber, '📋 You have no active reminders to cancel.');
    } else {
        // TODO: Implement selective cancellation (e.g., show a list of reminders to cancel)
        // For now, confirms cancellation of ALL active reminders.
        session.state = 'awaiting_cancel_confirmation';
        await sendInteractiveWhatsAppMessage(phoneNumber,
            `⚠️ You have ${userActiveRemindersCount} active reminder(s). Are you sure you want to cancel ALL of them?`,
            [
                { id: 'confirm_cancellation_all', title: 'Yes, Cancel All' },
                { id: 'decline_cancellation_all', title: 'No, Keep Them' },
            ]
        );
    }
}

async function handleShowStats(phoneNumber) {
    const profile = userProfiles[phoneNumber];
    if (!profile) { // Should not happen if new users are handled
        await sendWhatsAppMessage(phoneNumber, "I don't have any stats for you yet. Try setting a reminder!");
        return;
    }
    const activeCount = reminders.filter(r => r.phoneNumber === phoneNumber && r.active).length;
    const totalCreated = profile.totalReminders || 0;
    const completedCount = profile.completedReminders || 0;
    const successRate = (totalCreated > 0 && completedCount > 0)
        ? Math.round((completedCount / totalCreated) * 100)
        : 0;

    await sendWhatsAppMessage(phoneNumber,
        `📊 Your Reminder Stats:\n\n` +
        `📅 Member since: ${formatDateForDisplay(profile.joinedAt)}\n` +
        `📝 Total created: ${totalCreated}\n` +
        `⏰ Currently active: ${activeCount}\n` +
        `✅ Completed: ${completedCount}\n` +
        (totalCreated > 0 ? `📈 Completion rate: ${successRate}%\n` : '') +
        `\nKeep it up! 💪`
    );
}

async function handleHelp(phoneNumber) {
    await sendWhatsAppMessage(phoneNumber,
        `🤖 ${SITE_NAME} Help Center\n\n` +
        `I'm here to help you remember things and answer questions!\n\n` +
        `📝 --- REMINDER COMMANDS --- 📝\n` +
        `🔹 @remind [your task] [time/date]\n` +
        `   Example: "@remind buy groceries tomorrow at 5pm"\n` +
        `   Example: "remind me to workout in 1 hour"\n` +
        `   Example: "@remind team meeting every Monday at 10am"\n` +
        `🔹 @list - Shows your currently active reminders.\n` +
        `🔹 @cancel - Starts the process to cancel reminders.\n` +
        `🔹 @stats - Shows your reminder usage statistics.\n\n` +
        `⌚ --- TIME PHRASES --- ⌚\n` +
        `You can use natural language for times:\n` +
        `• "in 30 minutes", "in 2 hours", "in 3 days"\n` +
        `• "today at 2 PM", "tonight at 8", "tomorrow morning"\n` +
        `• "next Monday", "this Friday at noon"\n` +
        `• "every day at 9am", "every Tuesday"\n` +
        `• "on July 26th", "December 25 at 8:30am"\n\n` +
        `🤖 --- AI ASSISTANT --- 🤖\n` +
        `Simply chat with me! If it's not a command, I'll try my best to answer your question or have a conversation.\n\n` +
        `💡 Tip: Be as specific as possible with your reminder times for best results!\n` +
        `❓ Need more help? Just ask your question!`
    );
}


// --- Cron Jobs ---
// Reminder triggering cron (every minute)
cron.schedule('* * * * *', async () => {
    const now = new Date();
    // Iterate over a copy in case of modifications
    const currentRemindersSnapshot = [...reminders];
    let changed = false;

    for (const reminder of currentRemindersSnapshot) {
        if (!reminder.active || !reminder.triggerTime || !(reminder.triggerTime instanceof Date)) continue;

        if (now >= reminder.triggerTime) {
            console.log(`Triggering reminder ID ${reminder.id}: "${reminder.message}" for ${reminder.phoneNumber} at ${now.toISOString()}`);

            // Find the actual reminder in the main array to modify it
            const liveReminder = reminders.find(r => r.id === reminder.id);
            if (!liveReminder || !liveReminder.active) {
                console.log(`Reminder ${reminder.id} no longer active or found in live array, skipping.`);
                continue;
            }

            await sendInteractiveWhatsAppMessage(liveReminder.phoneNumber,
                `🔔 REMINDER ALERT! 🔔\n\n` +
                `📝 ${liveReminder.message}\n\n` +
                `⏰ Was scheduled for: ${formatDateForDisplay(liveReminder.triggerTime)}\n\n` + // Use original trigger time
                `Did you complete this task?`,
                [
                    { id: `completed_reminder_${liveReminder.id}`, title: '✅ Yes, Done!' },
                    { id: `snooze_reminder_${liveReminder.id}`, title: `😴 Snooze ${DEFAULT_SNOOZE_MINUTES}min` },
                ]
            );

            if (liveReminder.recurring) {
                const oldTriggerTime = new Date(liveReminder.triggerTime); // Base next on the current trigger time
                let nextTrigger = new Date(oldTriggerTime);

                switch (liveReminder.pattern.split('_')[0]) { // Use base pattern like 'daily', 'weekly'
                    case 'daily': nextTrigger.setDate(oldTriggerTime.getDate() + 1); break;
                    case 'weekly': nextTrigger.setDate(oldTriggerTime.getDate() + 7); break;
                    case 'monthly':
                        // Handle 'every month on the Xth' correctly
                        const dayOfMonth = liveReminder.pattern.includes('_') ? parseInt(liveReminder.pattern.split('_')[1],10) : oldTriggerTime.getDate();
                        nextTrigger.setMonth(oldTriggerTime.getMonth() + 1);
                        nextTrigger.setDate(dayOfMonth); // Ensure it's the correct day if specified
                        // Adjust if dayOfMonth is > days in next month (e.g. 31st for Feb)
                        if (nextTrigger.getDate() !== dayOfMonth) {
                            nextTrigger.setDate(0); // Last day of previous month (which is the target month now)
                        }
                        break;
                    // case 'yearly': nextTrigger.setFullYear(oldTriggerTime.getFullYear() + 1); break; // Add if yearly pattern implemented
                    default:
                        console.error(`Unknown recurring pattern: ${liveReminder.pattern} for reminder ${liveReminder.id}`);
                        liveReminder.active = false; // Deactivate unknown/broken recurring type
                        break;
                }
                // Ensure next trigger is truly in the future relative to 'now'
                while (nextTrigger <= now) { // Could happen with very frequent tasks or system clock adjustments
                     switch (liveReminder.pattern.split('_')[0]) {
                        case 'daily': nextTrigger.setDate(nextTrigger.getDate() + 1); break;
                        case 'weekly': nextTrigger.setDate(nextTrigger.getDate() + 7); break;
                        case 'monthly': nextTrigger.setMonth(nextTrigger.getMonth() + 1); break;
                        default: liveReminder.active = false; break; // Break from while loop for safety
                    }
                    if(!liveReminder.active) break;
                }

                if(liveReminder.active) {
                    liveReminder.triggerTime = nextTrigger;
                    liveReminder.snoozed = false; // Reset snooze state
                }

            } else {
                // One-time reminder has fired. It's no longer "active" in terms of needing to trigger.
                // User interaction (complete/snooze) will determine its final state.
                liveReminder.active = false;
                if (userProfiles[liveReminder.phoneNumber]) {
                    userProfiles[liveReminder.phoneNumber].activeReminders =
                        Math.max(0, (userProfiles[liveReminder.phoneNumber].activeReminders || 0) - 1);
                }
            }
            changed = true;
        }
    }

    if (changed) {
        saveData();
    }
});

// Session cleanup cron (e.g., every hour)
cron.schedule(`0 */1 * * *`, () => { // Every hour
    const oneHourAgo = new Date(Date.now() - SESSION_CLEANUP_INTERVAL_MS);
    let cleanedCount = 0;
    Object.keys(userSessions).forEach(phoneNumber => {
        if (new Date(userSessions[phoneNumber].lastActivity) < oneHourAgo) {
            delete userSessions[phoneNumber];
            cleanedCount++;
        }
    });
    if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} stale user sessions. Active sessions: ${Object.keys(userSessions).length}`);
    }
});


// --- Express Routes ---
// Webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('✅ Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        console.error('❌ Webhook verification failed. Mode:', mode, 'Received Token:', token, 'Expected:', WEBHOOK_VERIFY_TOKEN);
        res.sendStatus(403); // Forbidden
    }
});

// Webhook for receiving messages
app.post('/webhook', async (req, res) => {
    // Log raw body for debugging if necessary, but be mindful of PII
    // console.log('Webhook request body:', JSON.stringify(req.body, null, 2));

    try {
        const body = req.body;
        if (body.object === 'whatsapp_business_account') {
            for (const entry of body.entry || []) {
                for (const change of entry.changes || []) {
                    if (change.field === 'messages') {
                        const messageData = change.value.messages?.[0];
                        if (messageData) {
                            // Mark message as read (optional, good UX)
                            // await markMessageAsRead(messageData.id); // Implement this if desired

                            const phoneNumber = messageData.from;
                            let messageContent = '';
                            let messageType = messageData.type;
                            let buttonPayload = null;

                            switch (messageType) {
                                case 'text':
                                    messageContent = messageData.text.body;
                                    console.log(`📨 Text from ${phoneNumber}: ${messageContent}`);
                                    break;
                                case 'interactive':
                                    const interactiveType = messageData.interactive.type;
                                    if (interactiveType === 'button_reply') {
                                        buttonPayload = messageData.interactive.button_reply.id;
                                        messageContent = messageData.interactive.button_reply.title; // Context
                                        console.log(`🔘 Button from ${phoneNumber}: "${messageContent}" (ID: ${buttonPayload})`);
                                    } else if (interactiveType === 'list_reply') {
                                        buttonPayload = messageData.interactive.list_reply.id;
                                        messageContent = messageData.interactive.list_reply.title;
                                        console.log(`🔘 List from ${phoneNumber}: "${messageContent}" (ID: ${buttonPayload})`);
                                    } else {
                                        console.warn(`Unsupported interactive type from ${phoneNumber}: ${interactiveType}`);
                                        messageType = 'unsupported_interactive';
                                    }
                                    break;
                                default:
                                    console.log(`Unsupported message type "${messageType}" from ${phoneNumber}. Body: ${JSON.stringify(messageData)}`);
                                    messageType = 'unsupported_other';
                                    break;
                            }

                            if (!messageType.startsWith('unsupported')) {
                                await processMessage(phoneNumber, messageContent, messageType, buttonPayload);
                            } else {
                                await sendWhatsAppMessage(phoneNumber, "I received a message type I don't currently support. Please send text or use the buttons I provide.");
                            }
                        } else if (change.value.statuses) {
                             // Handle status updates (e.g., 'sent', 'delivered', 'read')
                             // console.log('Message status update:', change.value.statuses[0]);
                        }
                    }
                }
            }
            res.status(200).send('EVENT_RECEIVED');
        } else {
            res.sendStatus(404); // Not a WhatsApp event
        }
    } catch (error) {
        console.error('❌ Error in POST /webhook:', error.stack || error);
        res.status(500).send('Internal Server Error processing webhook');
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeReminders: reminders.filter(r => r.active).length,
        totalUsers: Object.keys(userProfiles).length,
        activeSessions: Object.keys(userSessions).length,
        memoryUsage: process.memoryUsage(),
    });
});

// Basic Admin Stats (Protect this endpoint in production!)
app.get('/admin/stats', (req, res) => {
    // IMPORTANT: In a production environment, this endpoint MUST be protected
    // by strong authentication and authorization mechanisms.
    // Example basic auth (replace with something robust like OAuth2, JWT, or IP whitelisting via reverse proxy):
    /*
    const auth = req.headers.authorization; // Basic <base64_encoded_credentials>
    if (!auth || !auth.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Authentication required.');
    }
    const [user, pass] = Buffer.from(auth.substring(6), 'base64').toString().split(':');
    if (user !== process.env.ADMIN_USER || pass !== process.env.ADMIN_PASS) { // Use env vars for credentials
        return res.status(401).send('Invalid credentials.');
    }
    */

    res.json({
        service: SITE_NAME,
        version: process.env.npm_package_version || 'N/A', // If running with npm start and package.json
        totalReminders: reminders.length,
        activeReminders: reminders.filter(r => r.active).length,
        completedReminders: reminders.filter(r => r.completed).length,
        recurringReminders: reminders.filter(r => r.recurring).length,
        totalUsers: Object.keys(userProfiles).length,
        activeSessions: Object.keys(userSessions).length,
        reminderTypesDistribution: reminders.reduce((acc, r) => {
            const typeKey = r.pattern || (r.recurring ? 'recurring_unknown' : 'once');
            acc[typeKey] = (acc[typeKey] || 0) + 1;
            return acc;
        }, {}),
        uptimeSeconds: process.uptime(),
        memoryUsage: process.memoryUsage(),
        environment: process.env.NODE_ENV || 'development',
        lastDataSaveAttempt: new Date().toISOString(), // This is just current time, better to log actual save times
    });
});

// --- Application Initialization and Shutdown ---
/**
 * Gracefully shuts down the application.
 * @param {string} signal The signal received (e.g., 'SIGINT', 'SIGTERM').
 */
function gracefulShutdown(signal) {
    console.log(`\n🔄 Received ${signal}. Starting graceful shutdown...`);
    // Stop accepting new requests (if applicable, server.close())
    // For Express, new connections will be handled by existing app.listen until it's closed.
    // However, for cron jobs and other async tasks, we should try to complete/save.

    console.log('Attempting to save all data...');
    saveData(); // Ensure data is saved
    console.log('💾 Data saving process completed.');

    // Add any other cleanup (e.g., close database connections)
    console.log('👋 Shutdown complete. Exiting.');
    process.exit(0);
}

// Global error handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error, origin) => {
    console.error(`❌ CRITICAL: Uncaught Exception at: ${origin}. Error:`, error.stack || error);
    console.error('Attempting to save data before emergency exit...');
    try {
        saveData();
        console.log('Data saving attempted during uncaughtException.');
    } catch (saveErr) {
        console.error('Failed to save data during uncaughtException:', saveErr);
    }
    // According to Node.js docs, process MUST exit after an uncaught exception.
    // Use a process manager (PM2, systemd) to restart.
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ CRITICAL: Unhandled Rejection at:', promise, 'Reason:', reason.stack || reason);
    // Depending on the application, you might attempt to recover or log and exit.
    // For now, log it. In a robust system, this might trigger alerts.
    // Consider if this requires an exit similar to uncaughtException.
});


/**
 * Initializes the application.
 */
async function initializeApp() {
    console.log(`🚀 Initializing ${SITE_NAME}...`);

    // Validate essential configurations
    const requiredEnvVars = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WEBHOOK_VERIFY_TOKEN'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
        console.error(`❌ FATAL: Missing critical environment variables: ${missingVars.join(', ')}. Please set them and restart.`);
        console.error('Application cannot start without these variables.');
        process.exit(1); // Exit if critical config is missing
    }
    if (!OPENROUTER_API_KEY) {
        console.warn('⚠️ OpenRouter API key (OPENROUTER_API_KEY) not found. AI features will use basic fallbacks.');
    } else {
        console.log('✅ OpenRouter AI features enabled.');
    }

    loadData(); // Load existing data

    console.log(`📊 Initial state: ${reminders.length} reminders, ${Object.keys(userProfiles).length} users.`);
    console.log(`⏰ Active reminders count at start: ${reminders.filter(r => r.active).length}`);

    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
        console.log(`✅ ${SITE_NAME} is running on port ${PORT}`);
        const displayUrl = SITE_URL !== 'https://your-app.com' ? SITE_URL : `http://localhost:${PORT}`;
        console.log(`🌐 Webhook URL (ensure Meta config points here): ${displayUrl}/webhook`);
        console.log(`❤️ Health check: ${displayUrl}/health`);
        console.log(`🛡️ Admin stats (example): ${displayUrl}/admin/stats (PROTECT THIS ROUTE!)`);
        console.log('🎯 Bot is ready and listening for messages!');
    }).on('error', (err) => {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    });

    // Handle server closing for graceful shutdown
    ['SIGINT', 'SIGTERM'].forEach(signal => {
        process.on(signal, () => {
            console.log(`\n📉 ${signal} received. Closing HTTP server...`);
            server.close(() => {
                console.log('HTTP server closed.');
                gracefulShutdown(signal); // Proceed with other cleanup
            });
            // If server doesn't close in time, force exit
            setTimeout(() => {
                console.error('Could not close connections in time, forcefully shutting down');
                process.exit(1);
            }, 10000); // 10 seconds timeout
        });
    });
}

// Start the application if this script is run directly
if (require.main === module) {
    initializeApp().catch(error => {
        console.error('❌ FATAL error during application initialization:', error.stack || error);
        process.exit(1);
    });
}

// Export modules for potential testing or extensibility (optional)
module.exports = {
    app,
    processMessage,
    parseReminderText,
    getAIResponse,
    sendWhatsAppMessage,
    loadData,
    saveData,
    // Expose state for advanced use cases or testing (use with caution)
    // reminders,
    // userProfiles,
    // userSessions,
};