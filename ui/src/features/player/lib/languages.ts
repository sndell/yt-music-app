/**
 * Languages Google's translate endpoint accepts, English first because it is
 * the target the translate menu starts on. ``iw`` is Hebrew under Google's own
 * code, and the two Chinese entries are the regional codes its detector
 * answers with.
 */
export type Language = { code: string; name: string; native: string };

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", native: "English" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "fr", name: "French", native: "Français" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "it", name: "Italian", native: "Italiano" },
  { code: "pt", name: "Portuguese", native: "Português" },
  { code: "ru", name: "Russian", native: "Русский" },
  { code: "uk", name: "Ukrainian", native: "Українська" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "ko", name: "Korean", native: "한국어" },
  { code: "zh-CN", name: "Chinese, Simplified", native: "简体中文" },
  { code: "zh-TW", name: "Chinese, Traditional", native: "繁體中文" },
  { code: "ar", name: "Arabic", native: "العربية" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "bn", name: "Bengali", native: "বাংলা" },
  { code: "tr", name: "Turkish", native: "Türkçe" },
  { code: "nl", name: "Dutch", native: "Nederlands" },
  { code: "pl", name: "Polish", native: "Polski" },
  { code: "sv", name: "Swedish", native: "Svenska" },
  { code: "no", name: "Norwegian", native: "Norsk" },
  { code: "da", name: "Danish", native: "Dansk" },
  { code: "fi", name: "Finnish", native: "Suomi" },
  { code: "cs", name: "Czech", native: "Čeština" },
  { code: "sk", name: "Slovak", native: "Slovenčina" },
  { code: "hu", name: "Hungarian", native: "Magyar" },
  { code: "ro", name: "Romanian", native: "Română" },
  { code: "bg", name: "Bulgarian", native: "Български" },
  { code: "el", name: "Greek", native: "Ελληνικά" },
  { code: "iw", name: "Hebrew", native: "עברית" },
  { code: "fa", name: "Persian", native: "فارسی" },
  { code: "ur", name: "Urdu", native: "اردو" },
  { code: "th", name: "Thai", native: "ไทย" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia" },
  { code: "ms", name: "Malay", native: "Bahasa Melayu" },
  { code: "tl", name: "Filipino", native: "Filipino" },
  { code: "hr", name: "Croatian", native: "Hrvatski" },
  { code: "sr", name: "Serbian", native: "Српски" },
  { code: "bs", name: "Bosnian", native: "Bosanski" },
  { code: "sl", name: "Slovenian", native: "Slovenščina" },
  { code: "sq", name: "Albanian", native: "Shqip" },
  { code: "lt", name: "Lithuanian", native: "Lietuvių" },
  { code: "lv", name: "Latvian", native: "Latviešu" },
  { code: "et", name: "Estonian", native: "Eesti" },
  { code: "is", name: "Icelandic", native: "Íslenska" },
  { code: "ga", name: "Irish", native: "Gaeilge" },
  { code: "ca", name: "Catalan", native: "Català" },
  { code: "eu", name: "Basque", native: "Euskara" },
  { code: "gl", name: "Galician", native: "Galego" },
  { code: "ka", name: "Georgian", native: "ქართული" },
  { code: "hy", name: "Armenian", native: "Հայերեն" },
  { code: "az", name: "Azerbaijani", native: "Azərbaycan" },
  { code: "kk", name: "Kazakh", native: "Қазақ" },
  { code: "uz", name: "Uzbek", native: "Oʻzbek" },
  { code: "sw", name: "Swahili", native: "Kiswahili" },
  { code: "ta", name: "Tamil", native: "தமிழ்" },
  { code: "te", name: "Telugu", native: "తెలుగు" },
  { code: "ml", name: "Malayalam", native: "മലയാളം" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
  { code: "mr", name: "Marathi", native: "मराठी" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "ne", name: "Nepali", native: "नेपाली" },
  { code: "si", name: "Sinhala", native: "සිංහල" },
  { code: "my", name: "Burmese", native: "ဗမာ" },
  { code: "km", name: "Khmer", native: "ខ្មែរ" },
  { code: "lo", name: "Lao", native: "ລາວ" },
  { code: "mn", name: "Mongolian", native: "Монгол" },
  { code: "am", name: "Amharic", native: "አማርኛ" },
  { code: "ha", name: "Hausa", native: "Harshen Hausa" },
  { code: "yo", name: "Yoruba", native: "Èdè Yorùbá" },
  { code: "zu", name: "Zulu", native: "isiZulu" },
  { code: "af", name: "Afrikaans", native: "Afrikaans" },
  { code: "cy", name: "Welsh", native: "Cymraeg" },
  { code: "la", name: "Latin", native: "Latina" },
];

/** The display name for a code, including the ones the detector returns. */
export const languageName = (code: string | null | undefined) => {
  if (!code) return null;
  const lower = code.toLowerCase();
  return LANGUAGES.find((entry) => entry.code.toLowerCase() === lower)?.name ?? null;
};

/** Case- and accent-insensitive search key, so "espanol" finds "Español". */
export const searchableText = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
