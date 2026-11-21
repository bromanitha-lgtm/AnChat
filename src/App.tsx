import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { isSupabaseConfigured, publicSupabase, supabase } from "./lib/supabase";
import type { Profile, Question } from "./lib/supabase";

type Language = "si" | "en";
type AuthStep = "identifier" | "password" | "register";
type SharedProfile = Profile & { questions: Question[] };
type AppNotification = {
  id: string;
  kind: "new_question" | "answer";
  question_id: string;
  question_body: string;
  answer_body: string | null;
  profile_display_name: string;
  profile_public_id: string;
  created_at: string;
  read_at: string | null;
};
type MagicWishCardId = "new-year" | "christmas" | "birthday" | "celebration";
type MagicWish = {
  cardId: MagicWishCardId;
  language: Language;
  recipient: string;
  askProfileId: string | null;
};
const wishCardCodes: Record<MagicWishCardId, string> = {
  "new-year": "n",
  christmas: "x",
  birthday: "b",
  celebration: "c",
};
const wishCardIds = Object.keys(wishCardCodes) as MagicWishCardId[];
const wishCards: Record<Language, Record<MagicWishCardId, { label: string; title: string; message: string; symbol: string }>> = {
  en: {
    "new-year": { label: "New Year", title: "Happy New Year!", message: "May the year ahead bring you joy, new beginnings, and moments worth celebrating.", symbol: "✿" },
    christmas: { label: "Christmas", title: "Merry Christmas!", message: "May your Christmas be filled with warmth, laughter, and little moments of magic.", symbol: "❄" },
    birthday: { label: "Birthday", title: "Happy Birthday!", message: "Wishing you a day full of smiles and a year filled with everything you love.", symbol: "✦" },
    celebration: { label: "Celebration", title: "A little joy for you", message: "Here’s to the good things in life and all the lovely moments still to come.", symbol: "♡" },
  },
  si: {
    "new-year": { label: "අලුත් අවුරුද්ද", title: "සුබ අලුත් අවුරුද්දක්!", message: "සතුට, සෞභාග්‍යය සහ අලුත් බලාපොරොත්තු පිරුණු අවුරුද්දක් වේවා!", symbol: "✿" },
    christmas: { label: "නත්තල", title: "සුබ නත්තලක්!", message: "සතුට, ආදරය සහ සුන්දර මතක පිරුණු නත්තලක් වේවා!", symbol: "❄" },
    birthday: { label: "උපන්දිනය", title: "සුබ උපන්දිනයක්!", message: "සිනහවෙන් පිරුණු ලස්සන දවසක් සහ සතුට පිරුණු අලුත් අවුරුද්දක් වේවා!", symbol: "✦" },
    celebration: { label: "විශේෂ දවසක්", title: "ඔයාට සතුට පිරුණු දවසක්!", message: "ජීවිතේ ලස්සන දේවල් සහ අලුත් සතුටු මොහොතවල් හැමදාම ලැබේවා!", symbol: "♡" },
  },
};

function parseMagicWish(params: URLSearchParams): MagicWish | null {
  const code = params.get("w");
  const language = params.get("l");
  const plainName = params.get("n");
  const encodedName = params.get("u");
  const askProfileId = params.get("a");
  const cardId = wishCardIds.find((id) => wishCardCodes[id] === code);
  const validProfileId = askProfileId === null
    || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(askProfileId);
  if (plainName !== null && encodedName !== null) return null;
  let recipient = plainName ?? "";
  if (encodedName !== null) {
    if (!/^[a-z0-9_-]{1,128}$/i.test(encodedName)) return null;
    try {
      const base64 = encodedName.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      recipient = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  if (
    !cardId
    || (language !== null && language !== "si" && language !== "en")
    || recipient.length > 24
    || /[\u0000-\u001f\u007f]/.test(recipient)
    || !validProfileId
  ) return null;
  return { cardId, language: language ?? "en", recipient: recipient.trim(), askProfileId };
}

function getMagicWishUrl(wish: MagicWish) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("w", wishCardCodes[wish.cardId]);
  if (wish.language === "si") url.searchParams.set("l", "si");
  if (wish.recipient) {
    if (/^[a-z0-9 _.-]+$/i.test(wish.recipient)) {
      url.searchParams.set("n", wish.recipient);
    } else {
      const bytes = new TextEncoder().encode(wish.recipient);
      const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
      url.searchParams.set("u", btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""));
    }
  }
  if (wish.askProfileId) url.searchParams.set("a", wish.askProfileId);
  return url.toString();
}

function getWishProfileUrl(profileId: string) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("to", profileId);
  return url.toString();
}

const questionDraftKeyPrefix = "anchat-question-draft:";
const lastQuestionDraftKey = "anchat-last-question-draft";

function getSavedQuestionDraftProfileId() {
  try {
    const profileId = sessionStorage.getItem(lastQuestionDraftKey);
    if (!profileId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(profileId)) return null;
    return sessionStorage.getItem(`${questionDraftKeyPrefix}${profileId}`)?.trim() ? profileId : null;
  } catch (error) {
    console.error("Could not read saved question draft", error);
    return null;
  }
}

function readQuestionDraft(profileId: string) {
  try {
    return sessionStorage.getItem(`${questionDraftKeyPrefix}${profileId}`) ?? "";
  } catch (error) {
    console.error("Could not restore question draft", error);
    return "";
  }
}

function saveQuestionDraft(profileId: string, value: string) {
  try {
    const key = `${questionDraftKeyPrefix}${profileId}`;
    if (value.trim()) {
      sessionStorage.setItem(key, value);
      sessionStorage.setItem(lastQuestionDraftKey, profileId);
    } else {
      sessionStorage.removeItem(key);
      if (sessionStorage.getItem(lastQuestionDraftKey) === profileId) {
        sessionStorage.removeItem(lastQuestionDraftKey);
      }
    }
    return true;
  } catch (error) {
    console.error("Could not save question draft", error);
    return false;
  }
}

function getMagicWishShareText(message: string, url: string) {
  const trimmedMessage = message.trim();
  return trimmedMessage ? `${trimmedMessage}\n\n${url}` : url;
}

const text = {
  si: {
    festival: "අවුරුදු විශේෂ",
    how: "කොහොමද වැඩ කරන්නේ?",
    eyebrow: "මේ අවුරුද්දේ, හිතේ තියෙන දේ අහන්න",
    heroLine1: "හිතේ තියෙන",
    heroLine2: "දේ",
    heroEmphasis: "අහන්න.",
    intro1: "Profile link එකෙන් නමක් නැතුව අහන්න.",
    intro2: "ප්‍රශ්නය ඒ profile එකේ විතරක් පේනවා.",
    askQuestion: "ප්‍රශ්නයක් අහන්න",
    seeQuestions: "ප්‍රශ්න බලන්න",
    privacyShort: "Login ඕන නෑ · නම default පේන්නේ නෑ",
    wish: "අවුරුදු පැතුමක්",
    wishLine1: "සතුට බෙදාගන්න,",
    wishLine2: "අලුත් මතක හදාගන්න.",
    profileYours: "ඔයාගේ profile එක",
    share: "Share profile",
    yourProfile: "ඔයාගේ profile එකක් හදාගන්න",
    profilePrompt: "ඔයාගේම link එක හදාගෙන යාළුවන් එක්ක බෙදාගන්න.",
    createProfile: "Profile එක හදාගන්න",
    login: "Log in",
    logout: "Log out",
    identifier: "Email හෝ username",
    identifierPlaceholder: "Email හෝ username එක ඇතුළත් කරන්න",
    continue: "ඉදිරියට",
    passwordHeading: "Password එක ඇතුළත් කරන්න",
    registerHeading: "Account එකක් හදාගන්න",
    createAccount: "Account එක හදන්න",
    emailForAccount: "ඔයාගේ email එක",
    usernameForAccount: "ඔයාගේ username එක",
    email: "Email",
    password: "Password",
    displayName: "ඔයාගේ නම",
    handle: "Username",
    namePlaceholder: "උදා: කවී",
    handlePlaceholder: "උදා: kavi_22",
    profileLink: "Share link එක හදාගන්න",
    accountRequired: "Profile එකක් හදන්න account එකක් හදාගන්න හෝ log in වෙන්න.",
    identifierRequired: "Email එකක් හෝ username එකක් ඇතුළත් කරන්න.",
    authPrompt: "Account එකක් තියෙනවද?",
    authPromptSignup: "අලුත් කෙනෙක්ද?",
    profileSigninNote: "Profile එක හදන්න සහ කළමනාකරණය කරන්න විသာ log in шаардлагатай.",
    accountNotice: "Profile එකක් හදන්න email එකෙන් log in වෙන්න, නැත්නම් account එකක් හදාගන්න.",
    loggedInAs: "Log වෙලා ඉන්නේ",
    sectionOne: "01 — ඔයාගේ හඬ",
    sectionTwo: "02 — හැමෝගෙම හඬ",
    yourInbox: "02 — ඔයාගේ Inbox එක",
    askTitle: "ප්‍රශ්නයක් අහන්න",
    askTo: "ගෙන් අහන්න",
    askDescription: "හිතේ තියෙන දෙයක් නිදහසේ අහන්න.",
    profileQuestions: "ට ආපු ප්‍රශ්න",
    backToAll: "← හැමෝගෙම ප්‍රශ්න බලන්න",
    draftRecoveryTitle: "ඔයාගේ draft එක save කරලා තියෙනවා",
    draftRecoveryBody: "මේ browser tab එකෙන් profile එකට ආයෙත් ගිහින් ලියපු දේ දිගටම කරගෙන යන්න.",
    resumeDraft: "දිගටම ලියන්න",
    discardDraft: "මකන්න",
    placeholder: "ඔයාගේ හිතේ තියෙන දේ මෙතන ලියන්න...",
    anonymous: "නිර්නාමිකව · ඔයාගේ නම පේන්නේ නෑ",
    publicFeed: "හැමෝටම පේනවා",
    send: "ප්‍රශ්නය යවන්න",
    sending: "යවමින්...",
    demo: "Demo preview එකක්. ඇත්තටම ප්‍රශ්න යවන්න Supabase සකස් කරන්න.",
    privacyTitle: "ඔයාගේ privacy එක වැදගත්",
    privacyBody: "පිළිතුරු නැති ප්‍රශ්න profile අයිතිකරුට පේනවා. Login වෙලා ප්‍රශ්නය අහපු කෙනාට තමන්ගේ ප්‍රශ්නයත් පේනවා. පිළිතුරු දුන් ප්‍රශ්න සහ පිළිතුරු මේ profile link එක ඇති අයට පේනවා. ඔයාගේ නම පෙන්වන්නේ නැහැ. පුද්ගලික තොරතුරු ලියන්න එපා.",
    anonymousPerson: "නිර්නාමික කෙනෙක්",
    questionTag: "අලුත් අවුරුදු කතා",
    noQuestions: "තවම ප්‍රශ්න නැහැ",
    firstQuestion: "ප්‍රශ්න ලැබෙන්න ඔයාගේ profile link එක share කරන්න.",
    inboxEmpty: "අලුත් ප්‍රශ්න මෙතන පෙන්වන්නම්.",
    loading: "ප්‍රශ්න ගෙන එනවා...",
    feedFootnote: "ප්‍රශ්න 50ක් දක්වා පෙන්වයි.",
    simple: "සරලයි. සැහැල්ලුයි.",
    stepsTitle1: "කතා පටන් ගන්නේ",
    stepsTitle2: "එහෙමයි.",
    step1Title: "හිතේ තියෙන දේ ලියන්න",
    step1Body: "Profile link එකෙන් login නැතුව අහන්න.",
    step2Title: "ප්‍රශ්න රහසිගතව තබාගන්න",
    step2Body: "පිළිතුරු නැති ප්‍රශ්න අයිතිකරුට සහ login වෙලා ඒවා ඇහුව අයට විතරයි පේන්නේ. අහපු අයට පේන්නේ තමන්ගේ ප්‍රශ්න විතරයි. පිළිතුරු දුන් Q&A profile link එකෙන් බලන්න පුළුවන්.",
    step3Title: "යාළුවන්ටත් කියන්න",
    step3Body: "Profile link එක WhatsApp හෝ Facebook එකට share කරන්න.",
    footer: "හිතේ තියෙන දේට ඉඩක්.",
    year: "අවුරුදු විශේෂ · හැමදාටම",
    language: "EN",
    themeLight: "Light mode",
    themeDark: "Dark mode",
    questionSuccess: "ඔයාගේ ප්‍රශ්නය යැව්වා! 💛",
    profileSuccess: "Profile එක හදාගත්තා! දැන් link එක share කරන්න. ✨",
    loginSuccess: "සාර්ථකව log වුණා.",
    logoutSuccess: "Log out වුණා.",
    verificationSent: "Email එකට verification link එකක් යැව්වා. Account එක සක්‍රිය කරන්න link එක open කරන්න.",
    linkCopied: "Profile link එක copy කළා! 💌",
    linkShared: "Profile link එක share කරන්න සූදානම්.",
    askLength: "ප්‍රශ්නය අකුරු 3ත් 500ත් අතර විය යුතුයි.",
    profileLength: "නම අකුරු 2ක්වත්, username එක අකුරු 3ක්වත් තිබිය යුතුයි.",
    duplicateHandle: "මේ username එක දැනටමත් භාවිතා වෙනවා.",
    duplicateProfile: "ඔයාගේ account එකට දැනටමත් profile එකක් තියෙනවා.",
    badCredentials: "Email හෝ password වැරදියි.",
    emailNotVerified: "Email එක තවම verify කරලා නැහැ. Email එකේ verification link එක open කරලා නැවත log in වෙන්න.",
    profileLinkRequired: "ප්‍රශ්නයක් අහන්න profile එකේ share link එකෙන් ඇතුළු වෙන්න.",
    profileUnavailable: "මේ link එකට අදාළ profile එක හමු වුණේ නැහැ.",
    profileLoadError: "Profile එක ගන්න බැරි වුණා. Internet connection එක පරීක්ෂා කරලා නැවත උත්සාහ කරන්න.",
    profileSetupError: "Profile එකේ දත්ත ගන්න database update එක අවශ්‍යයි. Site ownerට supabase/schema.sql නැවත run කරන්න කියන්න.",
    questionSetupError: "ප්‍රශ්නය යැවීමට අවශ්‍ය දත්ත සමුදා යාවත්කාලීනය මේ වෙබ් අඩවියේ නැහැ. වෙබ් අඩවියේ අයිතිකරුට Supabase Dashboard හි SQL Editor එකට supabase/schema.sql ගොනුවේ අන්තර්ගතය දමා ක්‍රියාත්මක කරන්න කියන්න. සම්පූර්ණ schema එක ක්‍රියාත්මක කිරීමෙන් මාස 2කට වඩා පැරණි ප්‍රශ්න සහ පිළිතුරු මැකිය හැකි නිසා, ඊට පෙර දත්ත උපස්ථයක් ගන්න. ඉන්පසු නැවත උත්සාහ කරන්න.",
    authError: "Account එක සමඟ සම්බන්ධ වීම අසාර්ථකයි. තොරතුරු පරීක්ෂා කර නැවත උත්සාහ කරන්න.",
    profileError: "Profile එක හදන්න බැරි වුණා. නැවත උත්සාහ කරන්න.",
    questionError: "ප්‍රශ්නය යවන්න බැරි වුණා. ටිකකින් නැවත උත්සාහ කරන්න.",
    loadError: "දත්ත ලබාගන්න බැරි වුණා. Supabase සැකසුම පරීක්ෂා කරන්න.",
    copyError: "Link එක copy කරන්න බැරි වුණා. Address bar එකෙන් copy කරන්න.",
    profilePrivate: "Profile එක බලන්න ඒකේ share link එක අවශ්‍යයි.",
    howShare: "දැන් WhatsApp හෝ Facebook එකට paste කරන්න.",
    profileOnly: "මේ profile එකටම අදාළයි",
    profileOnlyBody: "මේ ප්‍රශ්නය public feed එකේ පේන්නේ නැහැ. Profile අයිතිකරු පිළිතුරු දුන්නොත්, මේ ප්‍රශ්නය සහ පිළිතුර profile link එකෙන් බලන්න පුළුවන්. ඔයාගේ නම අනිත් අයට පේන්නේ නැහැ.",
    manageProfile: "මගේ profile එක බලන්න",
    signedInLabel: "Log වෙලා",
    yourQuestions: "ඔයාට ආපු ප්‍රශ්න",
    questionsForYou: "අහපු ප්‍රශ්න සහ පිළිතුරු",
    publicAnswers: "පිළිතුරු සහිත ප්‍රශ්න",
    noPublicAnswers: "තවම share කරපු පිළිතුරු නැහැ.",
    publicAnswer: "පිළිතුර",
    ownerProfile: "මේ ඔයාගේ profile එක",
    askerIdentity: "මගේ නම පෙන්වන්න",
    askerIdentityHelp: "Tick නොකළොත් ප්‍රශ්නය නිර්නාමිකයි. Default එකෙන් නම පෙන්වන්නේ නැහැ.",
    askWithName: "ඔයාගේ නම profile ownerට පේනවා",
    answerLabel: "ඔයාගේ පිළිතුර",
    answerPlaceholder: "මෙතනින් පිළිතුරු දෙන්න...",
    sendAnswer: "පිළිතුර යවන්න",
    updateAnswer: "පිළිතුර වෙනස් කරන්න",
    answerSuccess: "පිළිතුර යැව්වා. 💛",
    moreActions: "තවත් විකල්ප",
    editQuestion: "ප්‍රශ්නය සංස්කරණය කරන්න",
    deleteQuestion: "ප්‍රශ්නය මකන්න",
    editReply: "පිළිතුර සංස්කරණය කරන්න",
    deleteReply: "පිළිතුර මකන්න",
    saveChanges: "වෙනස්කම් සුරකින්න",
    cancel: "අවලංගු කරන්න",
    questionUpdated: "ඔයාගේ ප්‍රශ්නය වෙනස් කළා.",
    questionDeleted: "ඔයාගේ ප්‍රශ්නය මකා දැමුවා.",
    answerUpdated: "පිළිතුර වෙනස් කළා.",
    answerDeleted: "පිළිතුර මකා දැමුවා. ප්‍රශ්නය තවමත් profile අයිතිකරුට පෙනෙනවා.",
    confirmDeleteQuestion: "ඔයාගේ පිළිතුරු නොදුන් ප්‍රශ්නය මකා දමන්නද? මෙය ආපසු හැරවිය නොහැකියි.",
    confirmDeleteReply: "ඔයාගේ පිළිතුර මකා දමන්නද? ප්‍රශ්නය තවදුරටත් profile අයිතිකරුට පෙනෙනවා.",
    postActionPermissionError: "ඔයාට ඔයා ලියපු දේවල් විතරයි වෙනස් කරන්න පුළුවන්.",
    postActionSetupError: "මෙම ක්‍රියාව සඳහා database update එක අවශ්‍යයි. Site ownerට supabase/migrations/20261121_qa_post_management.sql ක්‍රියාත්මක කරන්න කියන්න.",
    postActionError: "වෙනස්කම සුරකින්න බැරි වුණා. නැවත උත්සාහ කරන්න.",
    answerError: "පිළිතුර යවන්න බැරි වුණා. නැවත උත්සාහ කරන්න.",
    answerSetupError: "පිළිතුරු යැවීමට database update එක අවශ්‍යයි. Site ownerට supabase/schema.sql නැවත run කරන්න කියන්න.",
    answerPermissionError: "ඔයාගේ profile එකට log වෙලා ඉන්නවාද කියලා පරීක්ෂා කරලා නැවත උත්සාහ කරන්න.",
    answerNetworkError: "පිළිතුර server එකට යවන්න බැරි වුණා. Internet එක පරීක්ෂා කරන්න; ඔයා ලියපු පිළිතුර තවම තියෙනවා.",
    answerTooLong: "පිළිතුර අකුරු 1ත් 2000ත් අතර විය යුතුයි.",
    notifications: "දැනුම්දීම්",
    notificationsEmpty: "තවම දැනුම්දීම් නැහැ.",
    notificationQuestion: "අලුත් ප්‍රශ්නයක් ලැබුණා",
    notificationAnswer: "ඔයාගේ ප්‍රශ්නයට පිළිතුරක් ලැබුණා",
    notificationError: "දැනුම්දීම් ලබාගන්න බැරි වුණා. නැවත උත්සාහ කරන්න.",
    realtimeError: "Live updates සම්බන්ධතාවය නැති වුණා. පිටුව refresh කරලා නැවත උත්සාහ කරන්න.",
    emailNotificationError: "Email දැනුම්දීම යවන්න බැරි වුණා.",
    magicWish: "Magic Wish",
    magicWishIntro: "ලස්සන card එකක් තෝරන්න. හැමෝටම එකම සුබපැතුම පේනවා; කැමති නම් ලබන්නාගේ නම දාන්න.",
    wishChooseCard: "Card එකක් තෝරන්න",
    wishAddName: "Add name",
    wishNameLabel: "ලබන්නාගේ නම",
    wishNamePlaceholder: "නම ඇතුළත් කරන්න",
    wishMessageLabel: "WhatsApp message එක",
    wishMessagePlaceholder: "Link එකට ඉහළින් යවන්න ඕන message එක මෙතන ලියන්න...",
    wishMessageHelp: "මේ message එක link එකට ඉහළින් යවයි. Card එකේ සුබපැතුම වෙනස් වෙන්නේ නැහැ.",
    wishAskToggle: "මගෙන් ප්‍රශ්නයක් අහන්න button එකක් දාන්න",
    wishAskHint: "Log වෙලා නම් default on. Wish එක විතරක් යවන්න නම් off කරන්න.",
    wishAskLoginHint: "Ask me button එක දාන්න log වෙන්න. Wish එක විතරක් account එකක් නැතුව යවන්න පුළුවන්.",
    wishCreate: "Magic Wish එක හදන්න",
    wishCreated: "Magic Wish එක සූදානම්! WhatsApp එකෙන් යවන්න. ✨",
    wishWhatsApp: "WhatsApp එකෙන් යවන්න",
    wishCopy: "සුබපැතුම + link එක copy කරන්න",
    wishCopied: "සුබපැතුමයි link එකයි copy කළා! 💌",
    wishCopyError: "Copy කරන්න බැරි වුණා. නැවත උත්සාහ කරන්න.",
    wishNameValidation: "ලබන්නාගේ නම ඇතුළත් කරන්න, නැත්නම් Add name එක අයින් කරන්න.",
    wishLoginRequired: "Ask me button එක දාන්න log වෙන්න.",
    wishProfileRequired: "Ask me button එක දාන්න මුලින් profile එකක් හදාගන්න.",
    wishClose: "සුබපැතුම වහන්න",
    wishAskButton: "මගෙන් ප්‍රශ්නයක් අහන්න",
    wishCardNote: "ඔයා වෙනුවෙන්ම පුංචි පැතුමක්",
    invalidWish: "මේ Magic Wish link එක වලංගු නැහැ.",
  },
  en: {
    festival: "New Year edition",
    how: "How it works",
    eyebrow: "This New Year, ask what is on your mind",
    heroLine1: "Ask what’s",
    heroLine2: "on your",
    heroEmphasis: "mind.",
    intro1: "Ask without your name through a profile link.",
    intro2: "Your question appears only on that profile.",
    askQuestion: "Ask a question",
    seeQuestions: "Browse questions",
    privacyShort: "No account needed · Your name is hidden by default",
    wish: "A New Year wish",
    wishLine1: "Share a little joy,",
    wishLine2: "make new memories.",
    profileYours: "Your profile",
    share: "Share profile",
    yourProfile: "Create your profile",
    profilePrompt: "Get your own private link and share it with friends.",
    createProfile: "Create a profile",
    login: "Log in",
    logout: "Log out",
    identifier: "Email or username",
    identifierPlaceholder: "Enter your email or username",
    continue: "Continue",
    passwordHeading: "Enter your password",
    registerHeading: "Create your account",
    createAccount: "Create account",
    emailForAccount: "Your email",
    usernameForAccount: "Your username",
    email: "Email",
    password: "Password",
    displayName: "Your name",
    handle: "Username",
    namePlaceholder: "e.g. Kavii",
    handlePlaceholder: "e.g. kavi_22",
    profileLink: "Create my share link",
    accountRequired: "Create an account or log in to make a profile.",
    identifierRequired: "Enter an email address or username.",
    authPrompt: "Already have an account?",
    authPromptSignup: "New here?",
    profileSigninNote: "You only need to log in to create and manage your profile.",
    accountNotice: "Log in with email or create an account to make a profile.",
    loggedInAs: "Signed in as",
    sectionOne: "01 — YOUR VOICE",
    sectionTwo: "02 — COMMUNITY",
    yourInbox: "02 — YOUR INBOX",
    askTitle: "Ask a question",
    askTo: "Ask",
    askDescription: "Ask anything that’s on your mind.",
    profileQuestions: "’s questions",
    backToAll: "← Back to community questions",
    draftRecoveryTitle: "Your draft is saved",
    draftRecoveryBody: "Return to the profile from this browser tab to continue where you left off.",
    resumeDraft: "Continue writing",
    discardDraft: "Discard",
    placeholder: "Write what’s on your mind...",
    anonymous: "Anonymous · Your name stays hidden",
    publicFeed: "Visible to everyone",
    send: "Send question",
    sending: "Sending...",
    demo: "Demo preview. Configure Supabase to send and share real data.",
    privacyTitle: "Your privacy matters",
    privacyBody: "Only the profile owner can see unanswered questions, except signed-in askers can see their own. Answered questions and replies are visible to anyone with this profile link. Your name stays hidden from visitors. Don’t include personal information.",
    anonymousPerson: "Anonymous visitor",
    questionTag: "New Year thoughts",
    noQuestions: "No questions yet",
    firstQuestion: "Share your profile link to receive questions.",
    inboxEmpty: "New questions will appear here.",
    loading: "Loading questions...",
    feedFootnote: "Showing up to 50 questions.",
    simple: "Simple. Thoughtful.",
    stepsTitle1: "Every conversation",
    stepsTitle2: "starts somewhere.",
    step1Title: "Write what’s on your mind",
    step1Body: "Ask from a profile link without logging in.",
    step2Title: "Your questions stay private",
    step2Body: "Only the owner and signed-in askers can see unanswered questions; askers can see only their own. Answered Q&A is visible from the profile link.",
    step3Title: "Share with your friends",
    step3Body: "Share your profile link on WhatsApp or Facebook.",
    footer: "A little space for what’s on your mind.",
    year: "New Year edition · Anytime",
    language: "සිං",
    themeLight: "Light mode",
    themeDark: "Dark mode",
    questionSuccess: "Your question was sent! 💛",
    profileSuccess: "Profile created! Share your link. ✨",
    loginSuccess: "You’re logged in.",
    logoutSuccess: "You’re logged out.",
    verificationSent: "We sent a verification link to your email. Open it to activate your account.",
    linkCopied: "Profile link copied! 💌",
    linkShared: "Ready to share your profile link.",
    askLength: "Your question must be between 3 and 500 characters.",
    profileLength: "Name must be at least 2 characters and username at least 3.",
    duplicateHandle: "That username is already taken.",
    duplicateProfile: "Your account already has a profile.",
    badCredentials: "Incorrect email or password.",
    emailNotVerified: "Your email is not verified yet. Open the verification link in your email, then log in again.",
    profileLinkRequired: "Open a profile using its share link to ask a question.",
    profileUnavailable: "That profile could not be found.",
    profileLoadError: "Could not load this profile. Check your connection and try again.",
    profileSetupError: "Loading profile questions needs the latest database schema. Ask the site owner to apply supabase/schema.sql.",
    questionSetupError: "Question sending needs the latest database schema. Ask the site owner to apply supabase/schema.sql.",
    authError: "Could not authenticate. Check your details and try again.",
    profileError: "Could not create your profile. Please try again.",
    questionError: "Could not send your question. Please try again.",
    loadError: "Could not load data. Check your Supabase setup.",
    copyError: "Could not copy the link. Copy it from the address bar.",
    profilePrivate: "You need that profile’s share link to view it.",
    howShare: "Paste it into WhatsApp or Facebook.",
    profileOnly: "Only for this profile",
    profileOnlyBody: "This question won’t appear in the public feed. If the owner replies, the question and answer will be visible to anyone with this profile link. Your name stays hidden from visitors.",
    manageProfile: "Open my profile",
    signedInLabel: "Signed in",
    yourQuestions: "Questions for you",
    questionsForYou: "Questions and replies",
    publicAnswers: "Answered questions",
    noPublicAnswers: "No answers have been shared yet.",
    publicAnswer: "Reply",
    ownerProfile: "This is your profile",
    askerIdentity: "Show my name",
    askerIdentityHelp: "Leave unchecked to ask anonymously. Your name is hidden by default.",
    askWithName: "Your name will be visible to the profile owner",
    answerLabel: "Your reply",
    answerPlaceholder: "Write your reply here...",
    sendAnswer: "Send reply",
    updateAnswer: "Update reply",
    answerSuccess: "Reply sent. 💛",
    moreActions: "More actions",
    editQuestion: "Edit question",
    deleteQuestion: "Delete question",
    editReply: "Edit reply",
    deleteReply: "Delete reply",
    saveChanges: "Save changes",
    cancel: "Cancel",
    questionUpdated: "Your question was updated.",
    questionDeleted: "Your question was deleted.",
    answerUpdated: "Reply updated.",
    answerDeleted: "Reply deleted. The profile owner can still see the question.",
    confirmDeleteQuestion: "Delete your unanswered question? This cannot be undone.",
    confirmDeleteReply: "Delete your reply? The profile owner will still see the question.",
    postActionPermissionError: "You can only change content you posted.",
    postActionSetupError: "Managing posts needs a database update. Ask the site owner to apply supabase/migrations/20261121_qa_post_management.sql.",
    postActionError: "Could not save that change. Please try again.",
    answerError: "Could not send your reply. Please try again.",
    answerSetupError: "Sending replies needs the latest database schema. Ask the site owner to apply supabase/schema.sql.",
    answerPermissionError: "Please sign in to the account that owns this profile, then try again.",
    answerNetworkError: "The reply could not reach the server. Check your connection; your draft is still here.",
    answerTooLong: "Your reply must be between 1 and 2000 characters.",
    notifications: "Notifications",
    notificationsEmpty: "No notifications yet.",
    notificationQuestion: "You received a new question",
    notificationAnswer: "Your question received a reply",
    notificationError: "Could not load notifications. Please try again.",
    realtimeError: "Live updates disconnected. Refresh the page and try again.",
    emailNotificationError: "The email notification could not be sent.",
    magicWish: "Magic Wish",
    magicWishIntro: "Choose a beautiful card. Everyone sees the same wish; add the recipient’s name if you like.",
    wishChooseCard: "Choose a card",
    wishAddName: "Add name",
    wishNameLabel: "Recipient’s name",
    wishNamePlaceholder: "Enter their name",
    wishMessageLabel: "Message for WhatsApp",
    wishMessagePlaceholder: "Write anything you’d like to say...",
    wishMessageHelp: "Your message will appear above the link. The greeting inside the card stays the same.",
    wishAskToggle: "Add an “Ask me” button",
    wishAskHint: "On by default when you’re logged in. Turn it off to share a wish only.",
    wishAskLoginHint: "Log in to add Ask me. You can share a wish-only card without an account.",
    wishCreate: "Create Magic Wish",
    wishCreated: "Your Magic Wish is ready to share! ✨",
    wishWhatsApp: "Send with WhatsApp",
    wishCopy: "Copy wish + link",
    wishCopied: "Wish and link copied! 💌",
    wishCopyError: "Could not copy the wish. Please try again.",
    wishNameValidation: "Enter the recipient’s name or turn off Add name.",
    wishLoginRequired: "Log in and create a profile to include the Ask Me button.",
    wishProfileRequired: "Create your profile first to include an Ask Me button.",
    wishClose: "Close wish",
    wishAskButton: "Ask me something",
    wishCardNote: "A little wish, just for you",
    invalidWish: "This Magic Wish link is invalid.",
  },
} as const;

const demoQuestions: Question[] = [
  {
    id: "demo-1",
    target_profile_id: null,
    body: "මේ අවුරුද්දේ ඔයා වැඩියෙන්ම සතුටු වුණේ මොන දේටද? 🌼",
    created_at: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
  },
  {
    id: "demo-2",
    target_profile_id: null,
    body: "අලුත් අවුරුද්දේ අනිවාර්යයෙන්ම කරන්න හිතාගෙන ඉන්න දෙයක් මොකක්ද?",
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
  {
    id: "demo-3",
    target_profile_id: null,
    body: "ඔයාට මේ අවුරුද්දට එකම එක පැතුමක් ඉල්ලන්න පුළුවන් නම්?",
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
];

function App() {
  const [initialWishState] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const wish = parseMagicWish(params);
    return { wish, invalid: params.has("w") && !wish };
  });
  const [language, setLanguage] = useState<Language>(
    () => (
      localStorage.getItem("hithe-ahanna-language-preference") === "set"
      && localStorage.getItem("hithe-ahanna-language") === "si"
        ? "si"
        : "en"
    ),
  );
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("hithe-ahanna-theme") === "dark" ? "dark" : "light"),
  );
  const [questions, setQuestions] = useState<Question[]>([]);
  const [myProfile, setMyProfile] = useState<Profile | null>(null);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const activeProfileIdRef = useRef<string | null>(null);
  const [questionText, setQuestionText] = useState("");
  const [draftRecoveryProfileId, setDraftRecoveryProfileId] = useState(getSavedQuestionDraftProfileId);
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [authUser, setAuthUser] = useState<User | null>(null);
  const authUserRef = useRef<User | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [authIdentifier, setAuthIdentifier] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authUsername, setAuthUsername] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authStep, setAuthStep] = useState<AuthStep>("identifier");
  const [isLoading, setIsLoading] = useState(isSupabaseConfigured);
  const [isSending, setIsSending] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [showAuthForm, setShowAuthForm] = useState(false);
  const [showNameOnQuestion, setShowNameOnQuestion] = useState(false);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [answeringQuestionId, setAnsweringQuestionId] = useState<string | null>(null);
  const [editingAnswerId, setEditingAnswerId] = useState<string | null>(null);
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [questionEditDraft, setQuestionEditDraft] = useState("");
  const [openPostMenu, setOpenPostMenu] = useState<{ questionId: string; kind: "question" | "answer" } | null>(null);
  const [savingQuestionId, setSavingQuestionId] = useState<string | null>(null);
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
  const [magicWish, setMagicWish] = useState<MagicWish | null>(initialWishState.wish);
  const [selectedWishCard, setSelectedWishCard] = useState<MagicWishCardId>("new-year");
  const [addRecipientName, setAddRecipientName] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [wishShareMessage, setWishShareMessage] = useState("");
  const [includeAskButton, setIncludeAskButton] = useState(false);
  const [createdWish, setCreatedWish] = useState<MagicWish | null>(null);
  const t = text[language];
  const routeParams = new URLSearchParams(window.location.search);
  const requestedProfileId = routeParams.has("w") ? null : routeParams.get("to");
  const isProfileRoute = Boolean(requestedProfileId);
  const isProfileRouteLoading = isProfileRoute && !activeProfile && isLoading;
  const isProfileRouteUnavailable = isProfileRoute && !activeProfile && !isLoading;
  activeProfileIdRef.current = activeProfile?.public_id ?? null;
  const previewWish = createdWish ?? {
    cardId: selectedWishCard,
    language,
    recipient: addRecipientName ? recipientName.trim() : "",
    askProfileId: null,
  };
  const previewCard = wishCards[previewWish.language][previewWish.cardId];
  const createdWishLink = createdWish ? getMagicWishUrl(createdWish) : "";
  const createdWishMessage = createdWish
    ? getMagicWishShareText(wishShareMessage, createdWishLink)
    : "";
  const isOwnerViewingProfile = Boolean(
    authUser && myProfile && activeProfile && myProfile.id === activeProfile.id,
  );

  const loadOwnedProfile = useCallback(async (userId: string): Promise<Profile | null> => {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("profiles")
      .select("id, handle, display_name, public_id")
      .eq("owner_id", userId)
      .maybeSingle();
    if (error) {
      setNotice(t.loadError);
      return null;
    }
    const profile = data as Profile | null;
    if (authUserRef.current?.id === userId) setMyProfile(profile);
    return profile;
  }, [t.loadError]);

  const refreshQuestions = useCallback(async (profilePublicId?: string) => {
    const requestedPublicId = profilePublicId ?? activeProfile?.public_id;
    if (requestedPublicId) {
      const profileClient = authUser ? supabase : publicSupabase;
      if (!profileClient) return;
      const { data, error } = await profileClient.rpc("get_shared_profile", {
        p_share_id: requestedPublicId,
      });
      if (error || !data) {
        setNotice(t.loadError);
        return;
      }
      const shared = data as unknown as SharedProfile;
      if (activeProfileIdRef.current !== requestedPublicId) return;
      setActiveProfile((profile) => profile?.public_id === requestedPublicId ? shared : profile);
      setQuestions(shared.questions ?? []);
      return;
    }

    if (!supabase) return;
    const { data, error } = await supabase
      .from("questions")
      .select("id, target_profile_id, body, created_at")
      .is("target_profile_id", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      setNotice(t.loadError);
      return;
    }
    setQuestions(data ?? []);
  }, [activeProfile?.public_id, authUser?.id, t.loadError]);

  const refreshNotifications = useCallback(async () => {
    if (!supabase) return;
    const userId = authUserRef.current?.id;
    if (!userId) {
      setNotifications([]);
      return;
    }

    const { data, error } = await supabase.rpc("get_my_notifications");
    if (authUserRef.current?.id !== userId) return;
    if (error) {
      setNotice(t.notificationError);
      return;
    }
    setNotifications((data ?? []) as AppNotification[]);
  }, [t.notificationError]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("hithe-ahanna-language", language);
    localStorage.setItem("hithe-ahanna-language-preference", "set");
    localStorage.setItem("hithe-ahanna-theme", theme);
  }, [language, theme]);

  useEffect(() => {
    if (initialWishState.invalid) setNotice(t.invalidWish);
  }, [initialWishState.invalid, t.invalidWish]);

  useEffect(() => {
    if (!magicWish) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMagicWish();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [magicWish]);

  useEffect(() => {
    setShowNameOnQuestion(false);
  }, [activeProfile?.id]);

  useEffect(() => {
    if (!activeProfile) return;
    const savedDraft = readQuestionDraft(activeProfile.public_id);
    setQuestionText(savedDraft);
    if (savedDraft.trim()) setDraftRecoveryProfileId(activeProfile.public_id);
    else setDraftRecoveryProfileId(getSavedQuestionDraftProfileId());
  }, [activeProfile?.public_id]);

  useEffect(() => {
    if (!supabase) {
      setQuestions(demoQuestions);
      setIsLoading(false);
      return;
    }

    let active = true;

    async function loadSession() {
      try {
        const sessionResult = await supabase!.auth.getSession();
        if (!active) return;
        if (sessionResult.error) setNotice(t.loadError);

        const user = sessionResult.data.session?.user ?? null;
        authUserRef.current = user;
        setAuthUser(user);
        setIncludeAskButton(Boolean(user));
        if (user) void loadOwnedProfile(user.id);
      } catch (error) {
        if (!active) return;
        console.error("Could not load the current session", error);
        setNotice(t.loadError);
      }
    }

    async function loadInitial() {
      if (requestedProfileId) {
        void loadSession();
        try {
          const { data, error } = await publicSupabase!.rpc("get_shared_profile", {
            p_share_id: requestedProfileId,
          });
          if (!active) return;
          if (error || !data) {
            if (error) {
              console.error("Could not load shared profile", { code: error.code, message: error.message });
              setNotice(
                error.code === "PGRST202" || error.code === "PGRST203" || error.code === "42883"
                  ? t.profileSetupError
                  : t.profileLoadError,
              );
            } else {
              setNotice(t.profileUnavailable);
            }
          } else {
            const shared = data as unknown as SharedProfile;
            setActiveProfile(shared);
            setQuestions(shared.questions ?? []);
          }
        } catch (error) {
          if (active) {
            console.error("Could not load shared profile", error);
            setNotice(t.profileLoadError);
          }
        } finally {
          if (active) setIsLoading(false);
        }
        return;
      }

      const [sessionResult, questionsResult] = await Promise.all([
        supabase!.auth.getSession(),
        supabase!
          .from("questions")
          .select("id, target_profile_id, body, created_at")
          .is("target_profile_id", null)
          .order("created_at", { ascending: false })
          .limit(50),
      ]);
      if (!active) return;

      if (sessionResult.error || questionsResult.error) setNotice(t.loadError);
      else setQuestions(questionsResult.data ?? []);

      const user = sessionResult.data.session?.user ?? null;
      authUserRef.current = user;
      setAuthUser(user);
      setIncludeAskButton(Boolean(user));
      if (user) void loadOwnedProfile(user.id);
      setIsLoading(false);
    }

    void loadInitial();
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      const user = session?.user ?? null;
      const resetWishSettings = event === "INITIAL_SESSION"
        || event === "SIGNED_IN"
        || event === "SIGNED_OUT"
        || authUserRef.current?.id !== user?.id;
      authUserRef.current = user;
      setAuthUser(user);
      if (resetWishSettings) {
        setIncludeAskButton(Boolean(user));
        setCreatedWish(null);
      }
      if (user) window.setTimeout(() => void loadOwnedProfile(user.id), 0);
      else setMyProfile(null);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [loadOwnedProfile, requestedProfileId, t.loadError, t.profileLoadError, t.profileSetupError, t.profileUnavailable]);

  useEffect(() => {
    if (activeProfile && isOwnerViewingProfile) {
      void refreshQuestions(activeProfile.public_id);
    }
  }, [activeProfile?.public_id, isOwnerViewingProfile, refreshQuestions]);

  useEffect(() => {
    const client = publicSupabase;
    const profileId = activeProfile?.public_id;
    if (!client || !profileId) return;

    let active = true;
    const channel = client
      .channel(`profile:${profileId}`)
      .on("broadcast", { event: "profile_updated" }, () => {
        if (active) void refreshQuestions(profileId);
      })
      .subscribe((status) => {
        if (!active) return;
        if (status === "SUBSCRIBED") {
          void refreshQuestions(profileId);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setNotice(t.realtimeError);
        }
      });

    return () => {
      active = false;
      void client.removeChannel(channel);
    };
  }, [activeProfile?.public_id, refreshQuestions, t.realtimeError]);

  useEffect(() => {
    const client = supabase;
    if (!client || !authUser) {
      setNotifications([]);
      setShowNotifications(false);
      return;
    }

    let active = true;
    const channel = client
      .channel(`notifications-${authUser.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `recipient_id=eq.${authUser.id}`,
        },
        () => {
          if (active) void refreshNotifications();
        },
      )
      .subscribe((status) => {
        if (active && (status === "CHANNEL_ERROR" || status === "TIMED_OUT")) {
          setNotice(t.notificationError);
        }
      });

    void refreshNotifications();
    return () => {
      active = false;
      void client.removeChannel(channel);
    };
  }, [authUser?.id, refreshNotifications, t.notificationError]);

  const profileUrl = myProfile
    ? `${window.location.origin}${window.location.pathname}?to=${encodeURIComponent(myProfile.public_id)}`
    : "";

  const displayQuestions = useMemo(() => questions.slice(0, 50), [questions]);
  const unreadNotificationCount = useMemo(
    () => notifications.reduce((count, item) => count + (item.read_at ? 0 : 1), 0),
    [notifications],
  );

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setIsBusy(true);

    if (authStep === "identifier") {
      const identifier = authIdentifier.trim();
      if (identifier.length < 3) {
        setNotice(t.identifierRequired);
        setIsBusy(false);
        return;
      }

      const { data, error } = await supabase.functions.invoke("account-auth", {
        body: { action: "check", identifier },
      });
      if (error || typeof data?.exists !== "boolean") {
        setNotice(t.authError);
      } else if (data.exists) {
        setAuthStep("password");
      } else {
        const isEmail = identifier.includes("@");
        setAuthEmail(isEmail ? identifier : "");
        setAuthUsername(isEmail ? "" : identifier.toLowerCase().replace(/[^a-z0-9_]/g, ""));
        setAuthStep("register");
      }
      setIsBusy(false);
      return;
    }

    if (password.length < 8) {
      setNotice(language === "si" ? "Password එක අවම අකුරු 8ක් විය යුතුයි." : "Password must be at least 8 characters.");
      setIsBusy(false);
      return;
    }

    if (authStep === "password") {
      const identifier = authIdentifier.trim();
      if (identifier.includes("@")) {
        const { error } = await supabase.auth.signInWithPassword({ email: identifier, password });
        if (error) setNotice(error.code === "email_not_confirmed" ? t.emailNotVerified : t.badCredentials);
        else {
          setNotice(t.loginSuccess);
          setShowAuthForm(false);
        }
      } else {
        const { data, error } = await supabase.functions.invoke("account-auth", {
          body: { action: "username-login", identifier, password },
        });
        const session = data?.session;
        if (data?.error === "email_not_confirmed") {
          setNotice(t.emailNotVerified);
        } else if (error || !session?.access_token || !session?.refresh_token) {
          setNotice(t.badCredentials);
        } else {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          });
          if (sessionError) setNotice(t.authError);
          else {
            setNotice(t.loginSuccess);
            setShowAuthForm(false);
          }
        }
      }
      setIsBusy(false);
      return;
    }

    const cleanEmail = authEmail.trim().toLowerCase();
    const cleanUsername = authUsername.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (cleanUsername.length < 3 || cleanUsername === "everyone" || authDisplayName.trim().length < 2) {
      setNotice(t.profileLength);
      setIsBusy(false);
      return;
    }

    const { data, error } = await supabase.functions.invoke("account-auth", {
      body: {
        action: "register",
        email: cleanEmail,
        username: cleanUsername,
        display_name: authDisplayName.trim(),
        password,
      },
    });
    if (error || data?.error) {
      setNotice(data?.error === "duplicate_handle" ? t.duplicateHandle : t.authError);
    } else if (data?.verification_required) {
      setPassword("");
      setShowAuthForm(false);
      setNotice(t.verificationSent);
    } else {
      setNotice(t.authError);
    }
    setIsBusy(false);
  }

  function resetAuthStep() {
    setAuthStep("identifier");
    setPassword("");
  }

  function createMagicWish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = recipientName.trim();
    if (addRecipientName && !name) {
      setNotice(t.wishNameValidation);
      return;
    }

    if (includeAskButton && !myProfile) {
      if (!authUser) {
        resetAuthStep();
        setShowAuthForm(true);
        setNotice(t.wishLoginRequired);
      } else if (isLoading) {
        setNotice(t.loading);
      } else {
        setShowProfileForm(true);
        setNotice(t.wishProfileRequired);
      }
      return;
    }

    setCreatedWish({
      cardId: selectedWishCard,
      language,
      recipient: addRecipientName ? name : "",
      askProfileId: includeAskButton && myProfile ? myProfile.public_id : null,
    });
    setNotice(t.wishCreated);
  }

  async function copyMagicWish() {
    try {
      await navigator.clipboard.writeText(createdWishMessage);
      setNotice(t.wishCopied);
    } catch {
      setNotice(t.wishCopyError);
    }
  }

  function closeMagicWish() {
    setMagicWish(null);
    window.history.replaceState({}, "", window.location.pathname);
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setNotice(t.authError);
    else {
      setShowProfileForm(false);
      setNotice(t.logoutSuccess);
    }
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !authUser) {
      setNotice(t.accountRequired);
      setShowAuthForm(true);
      return;
    }

    const cleanHandle = handle.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const cleanName = displayName.trim();
    if (cleanHandle.length < 3 || cleanHandle === "everyone" || cleanName.length < 2) {
      setNotice(t.profileLength);
      return;
    }

    setIsBusy(true);
    const { data, error } = await supabase
      .from("profiles")
      .insert({ owner_id: authUser.id, handle: cleanHandle, display_name: cleanName })
      .select("id, handle, display_name, public_id")
      .single();
    if (error) {
      setNotice(error.code === "23505" ? (error.message.includes("owner_id") ? t.duplicateProfile : t.duplicateHandle) : t.profileError);
    } else {
      setMyProfile(data as Profile);
      setShowProfileForm(false);
      setNotice(t.profileSuccess);
    }
    setIsBusy(false);
  }

  function dispatchNotificationEmail(questionId: string, successNotice: string) {
    if (!supabase) return;
    const warningNotice = `${successNotice} ${t.emailNotificationError}`;
    void supabase.functions
      .invoke("send-notification-email", { body: { question_id: questionId } })
      .then(({ error }) => {
        if (error) {
          console.error("Notification email dispatch failed", error);
          setNotice((current) => current === successNotice ? warningNotice : current);
        }
      })
      .catch((error: unknown) => {
        console.error("Notification email dispatch failed", error);
        setNotice((current) => current === successNotice ? warningNotice : current);
      });
  }

  async function sendQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      setNotice(t.demo);
      return;
    }
    if (!activeProfile) {
      setNotice(t.profileLinkRequired);
      return;
    }
    const body = questionText.trim();
    if (body.length < 3 || body.length > 500) {
      setNotice(t.askLength);
      return;
    }
    setIsSending(true);
    try {
      const { data: questionId, error } = await supabase.rpc("submit_profile_question", {
        p_target_profile_id: activeProfile.id,
        p_asker_profile_id: showNameOnQuestion && authUser && myProfile ? myProfile.id : null,
        p_body: body,
      });
      if (error) {
        console.error("Question submission failed", { code: error.code, message: error.message });
        setNotice(
          error.code === "PGRST202" || error.code === "PGRST203" || error.code === "42883"
            ? t.questionSetupError
            : t.questionError,
        );
        return;
      }
      if (typeof questionId !== "string") {
        console.error("Question submission RPC returned no question ID");
        setNotice(t.questionError);
        return;
      }

      saveQuestionDraft(activeProfile.public_id, "");
      setQuestionText("");
      setDraftRecoveryProfileId(getSavedQuestionDraftProfileId());
      setShowNameOnQuestion(false);
      setNotice(t.questionSuccess);
      dispatchNotificationEmail(questionId, t.questionSuccess);
    } catch (error) {
      console.error("Question submission request failed", error);
      setNotice(t.questionError);
    } finally {
      setIsSending(false);
    }
  }

  async function sendAnswer(event: FormEvent<HTMLFormElement>, questionId: string) {
    event.preventDefault();
    if (!supabase) {
      setNotice(t.demo);
      return;
    }
    if (!isOwnerViewingProfile) {
      setNotice(t.answerPermissionError);
      return;
    }

    const question = questions.find((item) => item.id === questionId);
    const isUpdating = Boolean(question?.answer);
    const body = (answerDrafts[questionId] ?? question?.answer?.body ?? "").trim();
    if (body.length < 1 || body.length > 2000) {
      setNotice(t.answerTooLong);
      return;
    }

    setAnsweringQuestionId(questionId);
    try {
      const { error } = await supabase.rpc("answer_profile_question", {
        p_question_id: questionId,
        p_body: body,
      });
      if (error) {
        console.error("Question answer failed", { code: error.code, message: error.message });
        const errorNotice =
          ["PGRST202", "PGRST203", "PGRST204", "42703", "42883"].includes(error.code)
            ? t.answerSetupError
            : error.code === "42501" || error.code === "PGRST301"
              ? t.answerPermissionError
              : error.code === "22023" || error.code === "23514"
                ? t.answerTooLong
                  : t.answerError;
        setNotice(`${errorNotice} (${error.code})`);
        return;
      }
      setEditingAnswerId(null);
      setNotice(isUpdating ? t.answerUpdated : t.answerSuccess);
      if (!isUpdating) dispatchNotificationEmail(questionId, t.answerSuccess);
      void refreshQuestions();
    } catch (error) {
      console.error("Question answer request failed", error);
      setNotice(t.answerNetworkError);
    } finally {
      setAnsweringQuestionId(null);
    }
  }

  function startQuestionEdit(question: Question) {
    setQuestionEditDraft(question.body);
    setEditingQuestionId(question.id);
    setOpenPostMenu(null);
  }

  function startAnswerEdit(question: Question) {
    setAnswerDrafts((drafts) => ({ ...drafts, [question.id]: question.answer?.body ?? "" }));
    setEditingAnswerId(question.id);
    setOpenPostMenu(null);
  }

  async function saveQuestionEdit(event: FormEvent<HTMLFormElement>, questionId: string) {
    event.preventDefault();
    if (!supabase) {
      setNotice(t.demo);
      return;
    }

    const question = questions.find((item) => item.id === questionId);
    const body = questionEditDraft.trim();
    if (!authUser || !question?.can_manage_question) {
      setNotice(t.postActionPermissionError);
      return;
    }
    if (body.length < 3 || body.length > 500) {
      setNotice(t.askLength);
      return;
    }

    setSavingQuestionId(questionId);
    try {
      const { error } = await supabase.rpc("update_profile_question", {
        p_question_id: questionId,
        p_body: body,
      });
      if (error) {
        console.error("Question update failed", { code: error.code, message: error.message });
        setNotice(
          ["PGRST202", "PGRST203", "42883"].includes(error.code)
            ? t.postActionSetupError
            : error.code === "42501" || error.code === "PGRST301"
              ? t.postActionPermissionError
              : t.postActionError,
        );
        return;
      }

      setEditingQuestionId(null);
      setQuestionEditDraft("");
      setNotice(t.questionUpdated);
      void refreshQuestions();
    } catch (error) {
      console.error("Question update request failed", error);
      setNotice(t.postActionError);
    } finally {
      setSavingQuestionId(null);
    }
  }

  async function deleteQuestionPost(questionId: string, kind: "question" | "answer") {
    if (!supabase) {
      setNotice(t.demo);
      return;
    }
    const question = questions.find((item) => item.id === questionId);
    const canManage = kind === "question"
      ? Boolean(authUser && question?.can_delete_question)
      : isOwnerViewingProfile && Boolean(question?.answer);
    if (!canManage) {
      setNotice(t.postActionPermissionError);
      return;
    }
    if (!window.confirm(kind === "question" ? t.confirmDeleteQuestion : t.confirmDeleteReply)) return;

    setDeletingPostId(questionId);
    try {
      const { error } = await supabase.rpc(
        kind === "question" ? "delete_profile_question" : "delete_profile_answer",
        { p_question_id: questionId },
      );
      if (error) {
        console.error("Q&A delete failed", { kind, code: error.code, message: error.message });
        setNotice(
          ["PGRST202", "PGRST203", "42883"].includes(error.code)
            ? t.postActionSetupError
            : error.code === "42501" || error.code === "PGRST301"
              ? t.postActionPermissionError
              : t.postActionError,
        );
        return;
      }

      setOpenPostMenu(null);
      setEditingAnswerId(null);
      setEditingQuestionId(null);
      setAnswerDrafts((drafts) => {
        const next = { ...drafts };
        delete next[questionId];
        return next;
      });
      setNotice(kind === "question" ? t.questionDeleted : t.answerDeleted);
      void refreshQuestions();
    } catch (error) {
      console.error("Q&A delete request failed", { kind, error });
      setNotice(t.postActionError);
    } finally {
      setDeletingPostId(null);
    }
  }

  async function openNotification(notification: AppNotification) {
    if (!supabase) return;
    if (!notification.read_at) {
      const { error } = await supabase.rpc("mark_notification_read", {
        p_notification_id: notification.id,
      });
      if (error) {
        setNotice(t.notificationError);
        return;
      }
      setNotifications((items) => items.map((item) => (
        item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item
      )));
    }

    setShowNotifications(false);
    const profileLink = new URL(getWishProfileUrl(notification.profile_public_id));
    profileLink.hash = "questions";
    window.location.assign(profileLink.toString());
  }

  async function shareProfile() {
    if (!profileUrl || !myProfile) return;
    try {
      if (navigator.share) {
        await navigator.share({
          title: `${myProfile.display_name} — ${language === "si" ? "ප්‍රශ්න අහන්න" : "ask me anything"}`,
          text: language === "si" ? "මගෙන් නිර්නාමිකව ඕනෑම දෙයක් අහන්න! 💌" : "Ask me anything anonymously! 💌",
          url: profileUrl,
        });
      } else {
        await navigator.clipboard.writeText(profileUrl);
        setNotice(`${t.linkCopied} ${t.howShare}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") setNotice(t.copyError);
    }
  }

  async function copyProfileLink() {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setNotice(t.linkCopied);
    } catch {
      setNotice(t.copyError);
    }
  }

  function openProfileSetup() {
    if (!authUser) {
      resetAuthStep();
      setShowAuthForm(true);
      setShowProfileForm(false);
      setNotice(t.accountRequired);
      return;
    }
    setShowProfileForm((open) => !open);
  }

  function closeSharedProfile() {
    activeProfileIdRef.current = null;
    setActiveProfile(null);
    setQuestions([]);
    window.history.replaceState({}, "", window.location.pathname);
    if (supabase) {
      void supabase
        .from("questions")
        .select("id, target_profile_id, body, created_at")
        .is("target_profile_id", null)
        .order("created_at", { ascending: false })
        .limit(50)
        .then(({ data, error }) => {
          if (error) setNotice(t.loadError);
          else setQuestions(data ?? []);
        });
    } else {
      setQuestions(demoQuestions);
    }
  }

  return (
    <>
    <main className={activeProfile ? "profile-active" : undefined}>
      <header className="topbar">
        <a className="brand" href={window.location.pathname} aria-label="anChat">
          <span className="brand-mark">a</span>
          <span>anChat</span>
        </a>
        <div className="topbar-right">
          {!isProfileRoute && <span className="festival-pill"><span className="tiny-sun">✳</span> {t.festival}</span>}
          {!isProfileRoute && <a className="top-link" href="#how-it-works">{t.how}</a>}
          <button className="top-control" onClick={() => setLanguage(language === "si" ? "en" : "si")} aria-label={language === "si" ? "Switch to English" : "භාෂාව සිංහලට මාරු කරන්න"}>{t.language}</button>
          <button className="top-control theme-control" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? t.themeDark : t.themeLight}>{theme === "light" ? "☾" : "☀"}</button>
          {authUser && (
            <div className="notification-menu">
              <button
                className="notification-trigger"
                type="button"
                aria-label={`${t.notifications}${unreadNotificationCount ? `, ${unreadNotificationCount}` : ""}`}
                aria-expanded={showNotifications}
                aria-controls="notification-panel"
                onClick={() => setShowNotifications((open) => !open)}
              >
                <span aria-hidden="true">♧</span>
                {unreadNotificationCount > 0 && (
                  <span className="notification-count">{unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}</span>
                )}
              </button>
              {showNotifications && (
                <section className="notification-panel" id="notification-panel" aria-label={t.notifications}>
                  <div className="notification-panel-heading">
                    <strong>{t.notifications}</strong>
                    {unreadNotificationCount > 0 && <span>{unreadNotificationCount}</span>}
                  </div>
                  {notifications.length ? (
                    <div className="notification-list">
                      {notifications.map((notification) => (
                        <button
                          className={`notification-item${notification.read_at ? "" : " unread"}`}
                          type="button"
                          key={notification.id}
                          onClick={() => void openNotification(notification)}
                        >
                          <span className={`notification-kind-icon ${notification.kind}`} aria-hidden="true">
                            {notification.kind === "new_question" ? "?" : "↩"}
                          </span>
                          <span className="notification-copy">
                            <strong>{notification.kind === "new_question" ? t.notificationQuestion : t.notificationAnswer}</strong>
                            <span>{notification.kind === "new_question" ? notification.question_body : notification.answer_body ?? notification.question_body}</span>
                            <small>{notification.profile_display_name} · {formatTime(notification.created_at, language)}</small>
                          </span>
                          {!notification.read_at && <span className="notification-unread-dot" aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="notification-empty">{t.notificationsEmpty}</p>
                  )}
                </section>
              )}
            </div>
          )}
          {authUser && <span className="signed-in-badge"><span />{t.signedInLabel}: {myProfile ? `@${myProfile.handle}` : authUser.email}</span>}
          {authUser ? (
            <button className="auth-nav" onClick={() => void signOut()}>{t.logout}</button>
          ) : (
            <button className="auth-nav" onClick={() => { resetAuthStep(); setShowAuthForm((open) => !open); }}>{t.login}</button>
          )}
        </div>
      </header>

      {showAuthForm && !authUser && (
        <form className="auth-form" onSubmit={(event) => void submitAuth(event)}>
          <div className="auth-form-heading">
            <strong>{authStep === "identifier" ? t.login : authStep === "password" ? t.passwordHeading : t.registerHeading}</strong>
            <span>{t.profileSigninNote}</span>
          </div>
          {authStep === "identifier" && (
            <label>{t.identifier}<input type="text" autoComplete="username" value={authIdentifier} onChange={(event) => setAuthIdentifier(event.target.value)} placeholder={t.identifierPlaceholder} required /></label>
          )}
          {authStep === "password" && (
            <>
              <div className="auth-identifier-value">{authIdentifier}<button type="button" onClick={resetAuthStep}>{language === "si" ? "වෙනස් කරන්න" : "Change"}</button></div>
              <label>{t.password}<input type="password" autoComplete="current-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            </>
          )}
          {authStep === "register" && (
            <>
              <div className="auth-identifier-value">{authIdentifier}<button type="button" onClick={resetAuthStep}>{language === "si" ? "වෙනස් කරන්න" : "Change"}</button></div>
              {authIdentifier.includes("@") ? (
                <label>{t.usernameForAccount}<input type="text" autoComplete="username" value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} minLength={3} maxLength={24} pattern="(?!everyone$)[A-Za-z0-9_]{3,24}" required /></label>
              ) : (
                <label>{t.emailForAccount}<input type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required /></label>
              )}
              <label>{t.displayName}<input type="text" autoComplete="name" value={authDisplayName} onChange={(event) => setAuthDisplayName(event.target.value)} maxLength={40} required /></label>
              <label>{t.password}<input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            </>
          )}
          <button className="button button-dark" disabled={isBusy || !isSupabaseConfigured}>
            {isBusy ? "…" : authStep === "identifier" ? t.continue : authStep === "password" ? t.login : t.createAccount}<span>↗</span>
          </button>
        </form>
      )}

      {isProfileRouteLoading && (
        <section className="profile-route-state" role="status" aria-live="polite">
          <span className="loading-spinner" />
          <strong>{t.loading}</strong>
        </section>
      )}
      {isProfileRouteUnavailable && (
        <section className="profile-route-state" role="alert">
          <span className="empty-flower">✿</span>
          <strong>{t.profileUnavailable}</strong>
          <a className="button button-outline" href={window.location.pathname}>{t.backToAll}</a>
        </section>
      )}

      {!activeProfile && !isProfileRoute && draftRecoveryProfileId && (
        <section className="draft-recovery" aria-live="polite">
          <span className="draft-recovery-icon" aria-hidden="true">✎</span>
          <div className="draft-recovery-copy">
            <strong>{t.draftRecoveryTitle}</strong>
            <span>{t.draftRecoveryBody}</span>
          </div>
          <a className="button button-dark" href={getWishProfileUrl(draftRecoveryProfileId)}>{t.resumeDraft}<span>↗</span></a>
          <button
            className="draft-recovery-discard"
            type="button"
            onClick={() => {
              saveQuestionDraft(draftRecoveryProfileId, "");
              setDraftRecoveryProfileId(getSavedQuestionDraftProfileId());
            }}
          >
            {t.discardDraft}
          </button>
        </section>
      )}

      {activeProfile && isOwnerViewingProfile && (
        <section className="profile-page-heading">
          <div className="profile-avatar">{activeProfile.display_name.slice(0, 1)}</div>
          <div className="profile-page-copy">
            <span className="section-kicker">{isOwnerViewingProfile ? t.ownerProfile : t.profileOnly}</span>
            <h1>{activeProfile.display_name}</h1>
            <span>@{activeProfile.handle}</span>
          </div>
          {isOwnerViewingProfile && <button className="button button-outline" onClick={() => void shareProfile()}>↗ <span>{t.share}</span></button>}
        </section>
      )}

      {!activeProfile && !isProfileRoute && <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> {t.eyebrow}</div>
          <h1>{t.heroLine1}<br />{t.heroLine2} <span>{t.heroEmphasis}</span></h1>
          <p className="hero-subtitle">{t.intro1}<br className="desktop-break" /> {t.intro2}</p>
          <div className="hero-actions">
            <a className="button button-dark" href={activeProfile ? "#ask" : "#questions"}>
              {activeProfile ? t.askQuestion : t.seeQuestions} <span>{activeProfile ? "↗" : "↓"}</span>
            </a>
            {!activeProfile && <a className="button button-outline magic-wish-hero-button" href="#magic-wish">{t.magicWish}<span>✦</span></a>}
            <a className="text-button" href={activeProfile ? "#questions" : "#how-it-works"}>
              {activeProfile ? t.seeQuestions : t.how} <span>↓</span>
            </a>
          </div>
          <div className="hero-note"><span className="note-icon">◉</span><span>{t.privacyShort}</span></div>
        </div>
        <div className="hero-art" aria-label={t.wish}>
          <div className="art-glow" /><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
          <span className="spark spark-one">✳</span><span className="spark spark-two">✦</span><span className="spark spark-three">✧</span><span className="floating-heart">♡</span>
          <div className="wish-card">
            <div className="wish-card-top"><span>{t.wish}</span><span className="wish-sun">☼</span></div>
            <div className="wish-flower">✿</div><p>{t.wishLine1}<br />{t.wishLine2}</p>
            <div className="wish-card-bottom"><span>anChat</span><span>✨</span></div>
          </div>
          <div className="art-caption"><span className="caption-dot" /> {language === "si" ? "හිතට ළං, හිතට නිදහස්" : "Close to the heart, free to ask"}</div>
          <span className="art-leaf leaf-one">❋</span><span className="art-leaf leaf-two">✳</span>
        </div>
      </section>}

      {!activeProfile && !isProfileRoute && myProfile ? (
        <section className="profile-strip">
          <div className="profile-avatar">{myProfile.display_name.slice(0, 1)}</div>
          <div className="profile-copy"><span className="profile-label">{t.profileYours}</span><strong>{myProfile.display_name} <span>@{myProfile.handle}</span></strong></div>
          <a className="button button-outline" href={profileUrl}>{t.manageProfile} <span>↗</span></a>
          <button className="button button-outline" onClick={() => void shareProfile()}>↗ <span>{t.share}</span></button>
          <button className="copy-button" onClick={() => void copyProfileLink()} aria-label={t.share}>▢</button>
        </section>
      ) : !activeProfile && !isProfileRoute && authUser ? (
        <section className="profile-prompt">
          <div className="prompt-icon">✿</div>
          <div className="profile-copy"><strong>{t.yourProfile}</strong><span>{t.profilePrompt}</span></div>
          <button className="button button-outline" onClick={() => setShowProfileForm((open) => !open)}>{t.createProfile} <span>↗</span></button>
        </section>
      ) : !activeProfile && !isProfileRoute ? (
        <section className="profile-prompt">
          <div className="prompt-icon">✿</div>
          <div className="profile-copy"><strong>{t.yourProfile}</strong><span>{t.profilePrompt}</span></div>
          <button className="button button-outline" onClick={openProfileSetup}>{t.createProfile} <span>↗</span></button>
        </section>
      ) : null}

      {!activeProfile && !isProfileRoute && showProfileForm && !myProfile && authUser && (
        <form className="profile-form" onSubmit={(event) => void createProfile(event)}>
          <label>{t.displayName}<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={40} placeholder={t.namePlaceholder} required /></label>
          <label>{t.handle}<input value={handle} onChange={(event) => setHandle(event.target.value)} maxLength={24} placeholder={t.handlePlaceholder} pattern="(?!everyone$)[A-Za-z0-9_]{3,24}" required /></label>
          <button className="button button-dark" disabled={isBusy}>{isBusy ? "…" : t.profileLink}<span>↗</span></button>
          <small>{t.loggedInAs} {authUser.email}</small>
        </form>
      )}

      {!activeProfile && !isProfileRoute && (
        <section className="magic-wish-section" id="magic-wish">
          <div className="magic-wish-intro">
            <span className="section-kicker">✦ {t.magicWish}</span>
            <h2>{language === "si" ? "උත්සව සුබපැතුමක් මැජික් එකක් කරන්න" : "Turn a festive greeting into a little surprise"}</h2>
            <p>{t.magicWishIntro}</p>
          </div>
          <div className="magic-wish-layout">
            <form className="magic-wish-form" onSubmit={createMagicWish}>
              <fieldset className="wish-card-choices">
                <legend>{t.wishChooseCard}</legend>
                <div className="wish-design-grid">
                  {wishCardIds.map((cardId) => {
                    const card = wishCards[language][cardId];
                    return (
                      <label className={`wish-design-option${selectedWishCard === cardId ? " selected" : ""}`} key={cardId}>
                        <input
                          type="radio"
                          name="wish-card"
                          value={cardId}
                          checked={selectedWishCard === cardId}
                          onChange={() => { setSelectedWishCard(cardId); setCreatedWish(null); }}
                        />
                        <span className={`wish-design-sample wish-theme-${cardId}`} aria-hidden="true">
                          <span>{card.symbol}</span>
                          <small>{card.label}</small>
                        </span>
                        <span className="wish-design-name">{card.label}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <label className="wish-name-toggle">
                <input type="checkbox" checked={addRecipientName} onChange={(event) => { setAddRecipientName(event.target.checked); setCreatedWish(null); }} />
                <span><strong>{t.wishAddName}</strong></span>
              </label>
              {addRecipientName && (
                <label className="wish-recipient-name">{t.wishNameLabel}
                  <input value={recipientName} onChange={(event) => { setRecipientName(event.target.value.slice(0, 24)); setCreatedWish(null); }} maxLength={24} placeholder={t.wishNamePlaceholder} required />
                </label>
              )}
              <label className="wish-message-input">{t.wishMessageLabel}
                <textarea value={wishShareMessage} onChange={(event) => setWishShareMessage(event.target.value.slice(0, 1000))} maxLength={1000} rows={3} placeholder={t.wishMessagePlaceholder} />
                <small>{t.wishMessageHelp}</small>
              </label>
              <label className={`wish-ask-toggle${authUser ? "" : " is-disabled"}`}>
                <input type="checkbox" checked={includeAskButton} disabled={!authUser} onChange={(event) => { setIncludeAskButton(event.target.checked); setCreatedWish(null); }} />
                <span><strong>{t.wishAskToggle}</strong><small>{authUser ? t.wishAskHint : t.wishAskLoginHint}</small></span>
              </label>
              {includeAskButton && !myProfile && (
                <div className="wish-requirement">
                  <span>{authUser ? t.wishProfileRequired : t.wishLoginRequired}</span>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      if (authUser) setShowProfileForm(true);
                      else {
                        resetAuthStep();
                        setShowAuthForm(true);
                      }
                    }}
                  >
                    {authUser ? t.createProfile : t.login} ↗
                  </button>
                </div>
              )}
              <button className="button button-dark wish-create-button" type="submit">{t.wishCreate}<span>✦</span></button>
            </form>

            <div className="magic-wish-share">
              <article className={`magic-wish-preview wish-theme-${previewWish.cardId}`}>
                <span className="wish-preview-spark spark-a">✦</span>
                <span className="wish-preview-spark spark-b">✳</span>
                <span className="wish-preview-label">{previewCard.label}</span>
                <span className="wish-card-note">{text[previewWish.language].wishCardNote}</span>
                {previewWish.recipient && <strong className="wish-preview-recipient">{previewWish.language === "en" ? `For ${previewWish.recipient}` : `${previewWish.recipient} වෙනුවෙන්`}</strong>}
                <h3>{previewCard.title}</h3>
                <span className="wish-card-divider" aria-hidden="true">✦</span>
                <span className="wish-preview-emblem" aria-hidden="true"><span className="wish-preview-flower">{previewCard.symbol}</span></span>
                <p>{previewCard.message}</p>
              </article>
              {createdWish ? (
                <>
                  <div className="wish-share-actions">
                    <a className="button button-whatsapp" href={`https://wa.me/?text=${encodeURIComponent(createdWishMessage)}`} target="_blank" rel="noopener noreferrer">{t.wishWhatsApp}<span>↗</span></a>
                    <button className="button button-outline" type="button" onClick={() => void copyMagicWish()}>{t.wishCopy}<span>▢</span></button>
                  </div>
                  <label className="wish-share-preview">{language === "si" ? "WhatsApp එකෙන් යන message එක" : "Message preview"}
                    <textarea value={createdWishMessage} readOnly rows={5} />
                  </label>
                </>
              ) : (
                <p className="wish-preview-note">{language === "si" ? "Card එක තෝරලා WhatsApp link එක හදාගන්න." : "Choose a card, then create its short share link."}</p>
              )}
            </div>
          </div>
        </section>
      )}

      {(!isProfileRoute || activeProfile) && <section className={`content-grid${activeProfile ? (isOwnerViewingProfile ? " owner-inbox" : " profile-view") : " home-feed"}`}>
        <div className={`profile-left-column${activeProfile && !isOwnerViewingProfile ? " is-shared-profile" : ""}`}>
          {activeProfile && !isOwnerViewingProfile && (
            <section className="profile-page-heading">
              <div className="profile-avatar">{activeProfile.display_name.slice(0, 1)}</div>
              <div className="profile-page-copy">
                <span className="section-kicker">{t.profileOnly}</span>
                <h1>{activeProfile.display_name}</h1>
                <span>@{activeProfile.handle}</span>
              </div>
            </section>
          )}
        <div className="questions-column" id="questions">
          {!isSupabaseConfigured && <div className="config-notice"><span>ⓘ</span><p>{t.demo} <code>.env</code></p></div>}
          <div className="feed-heading">
            <div className="section-heading">
              <span className="section-kicker">{isOwnerViewingProfile ? t.yourInbox : activeProfile ? t.publicAnswers : t.sectionTwo}</span>
              <h2>{activeProfile ? (isOwnerViewingProfile ? t.yourQuestions : t.questionsForYou) : language === "si" ? "අද අහපු දේවල්" : "Community questions"}</h2>
            </div>
            <span className="live-tag"><span /> {activeProfile ? "PROFILE" : "PUBLIC"}</span>
          </div>
          {isLoading ? (
            <div className="empty-state"><span className="loading-spinner" /> {t.loading}</div>
          ) : displayQuestions.length ? (
            <div className="question-list">
              {displayQuestions.map((question, index) => (
                <article className="question-card qa-conversation" key={question.id} style={{ animationDelay: `${index * 70}ms` }}>
                  <div className="question-card-top">
                    <span className="anonymous-avatar">{question.asker ? question.asker.display_name.slice(0, 1) : "?"}</span>
                    <span className="anonymous-label">{question.asker ? `${question.asker.display_name} @${question.asker.handle}` : t.anonymousPerson}</span>
                    <time>{question.id.startsWith("demo-") ? "" : formatTime(question.created_at, language)}</time>
                    {authUser && question.can_manage_question && (
                      <div className="post-menu">
                        <button
                          className="post-menu-trigger"
                          type="button"
                          aria-label={t.moreActions}
                          aria-haspopup="menu"
                          aria-controls={`question-actions-${question.id}`}
                          aria-expanded={openPostMenu?.questionId === question.id && openPostMenu.kind === "question"}
                          onClick={() => setOpenPostMenu((current) => current?.questionId === question.id && current.kind === "question" ? null : { questionId: question.id, kind: "question" })}
                        >
                          ⋯
                        </button>
                        {openPostMenu?.questionId === question.id && openPostMenu.kind === "question" && (
                          <div className="post-menu-items" id={`question-actions-${question.id}`} role="group" aria-label={t.moreActions}>
                            <button type="button" onClick={() => startQuestionEdit(question)}>{t.editQuestion}</button>
                            {question.can_delete_question && <button type="button" className="destructive-action" disabled={deletingPostId === question.id} onClick={() => void deleteQuestionPost(question.id, "question")}>{t.deleteQuestion}</button>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {editingQuestionId === question.id ? (
                    <form className="post-edit-form" onSubmit={(event) => void saveQuestionEdit(event, question.id)}>
                      <label className="sr-only" htmlFor={`question-edit-${question.id}`}>{t.editQuestion}</label>
                      <textarea
                        id={`question-edit-${question.id}`}
                        value={questionEditDraft}
                        onChange={(event) => setQuestionEditDraft(event.target.value.slice(0, 500))}
                        maxLength={500}
                        rows={3}
                        required
                      />
                      <div className="post-edit-footer">
                        <span>{questionEditDraft.length}/500</span>
                        <button className="text-button" type="button" onClick={() => { setEditingQuestionId(null); setQuestionEditDraft(""); }}>{t.cancel}</button>
                        <button className="button button-dark" type="submit" disabled={savingQuestionId === question.id}>{savingQuestionId === question.id ? t.sending : t.saveChanges}</button>
                      </div>
                    </form>
                  ) : (
                    <p className="question-post-body">{question.body}</p>
                  )}
                  {question.answer && editingAnswerId !== question.id && (
                    <div className="answer-display">
                      <div className="answer-display-heading">
                        <strong>{isOwnerViewingProfile ? t.answerLabel : t.publicAnswer}</strong>
                        {isOwnerViewingProfile && (
                          <div className="post-menu">
                            <button
                              className="post-menu-trigger"
                              type="button"
                              aria-label={t.moreActions}
                              aria-haspopup="menu"
                              aria-controls={`answer-actions-${question.id}`}
                              aria-expanded={openPostMenu?.questionId === question.id && openPostMenu.kind === "answer"}
                              onClick={() => setOpenPostMenu((current) => current?.questionId === question.id && current.kind === "answer" ? null : { questionId: question.id, kind: "answer" })}
                            >
                              ⋯
                            </button>
                            {openPostMenu?.questionId === question.id && openPostMenu.kind === "answer" && (
                              <div className="post-menu-items" id={`answer-actions-${question.id}`} role="group" aria-label={t.moreActions}>
                                <button type="button" onClick={() => startAnswerEdit(question)}>{t.editReply}</button>
                                <button type="button" className="destructive-action" disabled={deletingPostId === question.id} onClick={() => void deleteQuestionPost(question.id, "answer")}>{t.deleteReply}</button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <p>{question.answer.body}</p>
                    </div>
                  )}
                  {isOwnerViewingProfile && (!question.answer || editingAnswerId === question.id) && (
                    <form className="answer-form" onSubmit={(event) => void sendAnswer(event, question.id)}>
                      <label className="sr-only" htmlFor={`answer-${question.id}`}>{t.answerLabel}</label>
                      <textarea
                        id={`answer-${question.id}`}
                        value={answerDrafts[question.id] ?? question.answer?.body ?? ""}
                        onChange={(event) => setAnswerDrafts((drafts) => ({ ...drafts, [question.id]: event.target.value.slice(0, 2000) }))}
                        placeholder={t.answerPlaceholder}
                        maxLength={2000}
                        rows={3}
                        required
                      />
                      <div className="answer-form-bottom">
                        <span>{(answerDrafts[question.id] ?? question.answer?.body ?? "").length}/2000</span>
                        {question.answer && <button className="text-button" type="button" onClick={() => { setEditingAnswerId(null); setAnswerDrafts((drafts) => ({ ...drafts, [question.id]: question.answer?.body ?? "" })); }}>{t.cancel}</button>}
                        <button className="button button-dark" type="submit" disabled={answeringQuestionId === question.id}>
                          {answeringQuestionId === question.id ? t.sending : question.answer ? t.updateAnswer : t.sendAnswer}
                        </button>
                      </div>
                    </form>
                  )}
                  <div className="question-card-bottom"><span>{t.questionTag}</span><span>✦</span></div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-flower">✿</span>
              <strong>{activeProfile && !isOwnerViewingProfile ? t.noPublicAnswers : t.noQuestions}</strong>
              <span>{isOwnerViewingProfile ? t.inboxEmpty : activeProfile ? t.noPublicAnswers : t.firstQuestion}</span>
            </div>
          )}
          {displayQuestions.length > 0 && <p className="feed-footnote">{t.feedFootnote}</p>}
        </div>
        </div>
        {activeProfile && !isOwnerViewingProfile && <div className="ask-column" id="ask">
          <div className="section-heading">
            <span className="section-kicker">{t.sectionOne}</span>
            <h2>{language === "en" ? `${t.askTo} ${activeProfile.display_name} anything` : `${activeProfile.display_name} ${t.askTo}`}</h2>
            <p>{t.askDescription}</p>
          </div>
          <button className="back-link" onClick={closeSharedProfile}>{t.backToAll}</button>
          <form className="question-form" onSubmit={(event) => void sendQuestion(event)}>
            <label className="sr-only" htmlFor="question">{t.askTitle}</label>
            <textarea
              id="question"
              value={questionText}
              onChange={(event) => {
                const value = event.target.value.slice(0, 500);
                setQuestionText(value);
                saveQuestionDraft(activeProfile.public_id, value);
                setDraftRecoveryProfileId(value.trim() ? activeProfile.public_id : getSavedQuestionDraftProfileId());
              }}
              placeholder={t.placeholder}
              maxLength={500}
              rows={5}
            />
            {authUser && myProfile && (
              <label className="identity-toggle">
                <input type="checkbox" checked={showNameOnQuestion} onChange={(event) => setShowNameOnQuestion(event.target.checked)} />
                <span><strong>{t.askerIdentity}</strong><small>{t.askerIdentityHelp}</small></span>
              </label>
            )}
            <div className="form-meta">
              <span><span className="privacy-lock">⌑</span> {showNameOnQuestion ? t.askWithName : t.anonymous}</span>
              <span>{questionText.length}/500</span>
            </div>
            <div className="form-bottom">
              <span className="public-label"><span /> {t.profileOnly}</span>
              <button className="button button-dark send-button" type="submit" disabled={!isSupabaseConfigured || isSending}>
                {isSending ? t.sending : t.send} <span>↗</span>
              </button>
            </div>
          </form>
          <div className="privacy-card"><span className="privacy-icon">✳</span><div><strong>{t.privacyTitle}</strong><p>{t.privacyBody}</p></div></div>
          <div className="privacy-card profile-private-card"><span className="privacy-icon">⌑</span><div><strong>{t.profileOnly}</strong><p>{t.profileOnlyBody}</p></div></div>
        </div>}
      </section>}

      {!activeProfile && !isProfileRoute && <section className="how-section" id="how-it-works">
        <div className="how-title"><span className="section-kicker">{t.simple}</span><h2>{t.stepsTitle1}<br />{t.stepsTitle2}</h2></div>
        <div className="how-step"><span>01</span><div className="step-icon">✍</div><h3>{t.step1Title}</h3><p>{t.step1Body}</p></div>
        <div className="how-step"><span>02</span><div className="step-icon">♡</div><h3>{t.step2Title}</h3><p>{t.step2Body}</p></div>
        <div className="how-step"><span>03</span><div className="step-icon">↗</div><h3>{t.step3Title}</h3><p>{t.step3Body}</p></div>
      </section>}

      <footer className="footer">
        <a className="brand" href={window.location.pathname}><span className="brand-mark">a</span><span>anChat</span></a>
        <span>{t.footer} <span className="footer-heart">♡</span></span>
        <span className="footer-year">{t.year}</span>
      </footer>

      {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Close">×</button></div>}
    </main>
    {magicWish && createPortal(
      <div
        className="magic-wish-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeMagicWish();
        }}
      >
        <article className={`magic-wish-open-card wish-theme-${magicWish.cardId}`} role="dialog" aria-modal="true" aria-labelledby="opened-wish-title">
          <button className="wish-close-button" type="button" onClick={closeMagicWish} aria-label={t.wishClose}>×</button>
          <div className="opened-wish-top"><span className="opened-wish-badge"><span aria-hidden="true">✦</span>{wishCards[magicWish.language][magicWish.cardId].label}</span><span className="opened-wish-sun" aria-hidden="true">✧</span></div>
          {magicWish.recipient && <span className="opened-wish-recipient">{magicWish.language === "en" ? `For ${magicWish.recipient}` : `${magicWish.recipient} වෙනුවෙන්`}</span>}
          <span className="wish-card-note">{text[magicWish.language].wishCardNote}</span>
          <h1 id="opened-wish-title">{wishCards[magicWish.language][magicWish.cardId].title}</h1>
          <span className="wish-card-divider" aria-hidden="true">✦</span>
          <div className="opened-wish-emblem" aria-hidden="true"><span className="opened-wish-flower">{wishCards[magicWish.language][magicWish.cardId].symbol}</span></div>
          <p className="opened-wish-message">{wishCards[magicWish.language][magicWish.cardId].message}</p>
          <div className="opened-wish-actions">
            {magicWish.askProfileId && (
              <a className="button button-dark wish-ask-button" href={getWishProfileUrl(magicWish.askProfileId)}>
                {t.wishAskButton}
                <span>↗</span>
              </a>
            )}
            <button className="wish-close-text" type="button" onClick={closeMagicWish}>{t.wishClose}</button>
          </div>
          <span className="opened-wish-foot">anChat <span>♡</span></span>
        </article>
        <span className="wish-backdrop-spark wish-spark-one">✦</span>
        <span className="wish-backdrop-spark wish-spark-two">✳</span>
        <span className="wish-backdrop-spark wish-spark-three">♡</span>
      </div>,
      document.body,
    )}
    </>
  );
}

function formatTime(dateString: string, language: Language) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(dateString).getTime()) / 60_000));
  if (language === "en") {
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
  if (minutes < 1) return "දැන්";
  if (minutes < 60) return `මිනිත්තු ${minutes}කට පෙර`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `පැය ${hours}කට පෙර`;
  return `${Math.floor(hours / 24)} දිනකට පෙර`;
}

export default App;
