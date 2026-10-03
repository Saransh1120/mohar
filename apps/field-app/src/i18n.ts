/**
 * ── The field app in two languages ───────────────────────────────────────────
 *
 * Every line the app itself says, in English and in Hindi. A courier or an
 * officer reads this screen standing at a packet; it should be in the language
 * they read.
 *
 * What is not translated, on purpose: what the ledger answers. A check's name,
 * its evidence line and a deny reason are shown exactly as the engine returned
 * them, because that text is the record and a translation of it made on the
 * phone would be this app's wording, not the engine's. The screen says so.
 *
 * Switching language changes the words in place and reloads nothing: a
 * transfer key held in memory between Receive and Confirm must survive it.
 */

export type Lang = "en" | "hi";

const STRINGS = {
  // ── the scan screen ──
  online: { en: "online", hi: "ऑनलाइन" },
  offline: { en: "offline", hi: "ऑफ़लाइन" },
  h_scan: { en: "Courier scan", hi: "कूरियर स्कैन" },
  p_signed: {
    en: "Signed on this phone when observed. Queued records keep their original time and ID while offline.",
    hi: "जो देखा गया, उस पर उसी समय इसी फ़ोन से हस्ताक्षर होता है। नेटवर्क न होने पर रिकॉर्ड कतार में रहते हैं और उनका मूल समय और आईडी नहीं बदलती।",
  },
  p_enrol: {
    en: "A control-room operator enrols this phone with their username and password. If the phone has a platform authenticator, its owner registers a fingerprint or face unlock while the operator is present. The ledger stores a public key, never a fingerprint. This is the phone's own unlock, not the R307 reader.",
    hi: "कंट्रोल रूम का ऑपरेटर अपने यूज़रनेम और पासवर्ड से इस फ़ोन को दर्ज करता है। यदि फ़ोन में प्लेटफ़ॉर्म प्रमाणक है, तो ऑपरेटर की मौजूदगी में मालिक फ़िंगरप्रिंट या फ़ेस अनलॉक दर्ज करता है। लेजर केवल सार्वजनिक कुंजी रखता है, फ़िंगरप्रिंट नहीं। यह फ़ोन का अपना अनलॉक है, R307 रीडर नहीं।",
  },
  l_exam: { en: "Exam ID", hi: "परीक्षा आईडी" },
  l_centre: { en: "Centre ID", hi: "केंद्र आईडी" },
  l_person: { en: "Person ID", hi: "व्यक्ति आईडी" },
  l_op_user: { en: "Operator username", hi: "ऑपरेटर का यूज़रनेम" },
  l_op_pass: { en: "Operator password", hi: "ऑपरेटर का पासवर्ड" },
  b_enrol: { en: "Enrol this phone", hi: "इस फ़ोन को दर्ज करें" },
  platform_enrolled: { en: "phone unlock registered", hi: "फ़ोन अनलॉक दर्ज है" },
  simulated_only: { en: "simulated fingerprint mode; no platform proof", hi: "बनावटी फ़िंगरप्रिंट मोड; फ़ोन का प्रमाण नहीं" },
  l_replace_cred: {
    en: "Replace the phone unlock already registered for this person (lost phone, cleared storage, or an enrolment that stopped half way). The control room is told.",
    hi: "इस व्यक्ति का पहले से दर्ज फ़ोन अनलॉक बदलें (फ़ोन खो गया, डेटा मिट गया, या पिछली बार दर्ज करना बीच में रुक गया)। कंट्रोल रूम को इसकी सूचना जाती है।",
  },
  e_platform_exists: {
    en: "This person already has a phone unlock registered. If it is to be replaced, the operator ticks the box above and enrols again.",
    hi: "इस व्यक्ति का फ़ोन अनलॉक पहले से दर्ज है। उसे बदलना हो तो ऑपरेटर ऊपर का बॉक्स टिक करके दोबारा दर्ज करे।",
  },
  e_platform_register: { en: "Phone unlock registration failed", hi: "फ़ोन अनलॉक दर्ज नहीं हुआ" },
  e_platform_unavailable: { en: "Registered phone unlock is unavailable here", hi: "दर्ज फ़ोन अनलॉक यहाँ उपलब्ध नहीं है" },
  e_platform_challenge: { en: "The ledger could not issue a phone unlock challenge", hi: "लेजर फ़ोन अनलॉक चुनौती नहीं दे सका" },
  l_package: { en: "Package ID", hi: "पैकेट आईडी" },
  l_photo: { en: "Seal photo", hi: "सील की फ़ोटो" },
  l_qr: { en: "QR code", hi: "क्यूआर कोड" },
  l_raw: { en: "Identifier read", hi: "पढ़ी गई पहचान" },
  ph_raw: { en: "QR or NFC text", hi: "क्यूआर या एनएफ़सी का पाठ" },
  b_record: { en: "Record signed scan", hi: "हस्ताक्षरित स्कैन दर्ज करें" },

  // ── hand-off ──
  h_handoff: { en: "Hand-off", hi: "सुपुर्दगी" },
  p_handoff: {
    en: "These three steps are signed by this enrolled phone. Keep both QR images until Confirm. A registered phone unlock proves the owner was present through WebAuthn. The slot and score below remain simulated and are recorded as a separate check; they are not an R307 reading.",
    hi: "ये तीनों कदम इस दर्ज फ़ोन के हस्ताक्षर से जाते हैं। पुष्टि तक दोनों क्यूआर फ़ोटो रखें। दर्ज फ़ोन अनलॉक WebAuthn से मालिक की मौजूदगी साबित करता है। नीचे का स्लॉट और स्कोर अब भी बनावटी हैं और अलग जाँच में दर्ज होते हैं; यह R307 की रीडिंग नहीं है।",
  },
  p_engine_words: {
    en: "What the ledger answers (each check and its evidence) is shown exactly as it arrived.",
    hi: "लेजर का जवाब (हर जाँच और उसका प्रमाण) ठीक वैसा ही दिखाया जाता है जैसा आया, यानी अंग्रेज़ी में।",
  },
  b_load_legs: { en: "Load legs for package above", hi: "ऊपर वाले पैकेट के चरण लाएँ" },
  l_leg: { en: "Leg", hi: "चरण" },
  l_qr_a: { en: "QR A image", hi: "क्यूआर A की फ़ोटो" },
  l_qr_b: { en: "QR B image", hi: "क्यूआर B की फ़ोटो" },
  l_finger: { en: "Simulated fingerprint", hi: "बनावटी फ़िंगरप्रिंट" },
  o_match: { en: "Simulated match (slot 3, score 180)", hi: "बनावटी मिलान (स्लॉट 3, स्कोर 180)" },
  o_mismatch: { en: "Simulated mismatch (slot 3, score 40)", hi: "बनावटी बेमेल (स्लॉट 3, स्कोर 40)" },
  o_none: { en: "Not read", hi: "पढ़ा नहीं गया" },
  l_serial_recv: { en: "Packet serial typed by receiver", hi: "प्राप्त करने वाले का लिखा पैकेट सीरियल" },
  l_override_id: {
    en: "Approved damaged-label override ID (in place of both QR scans)",
    hi: "मंज़ूर ओवरराइड की आईडी (लेबल खराब हो तो दोनों क्यूआर स्कैन की जगह)",
  },
  b_dispatch: { en: "Dispatch", hi: "रवाना करें" },
  b_receive: { en: "Receive", hi: "प्राप्त करें" },
  b_confirm: { en: "Confirm with key held in memory", hi: "मेमोरी में रखी चाबी से पुष्टि करें" },
  step_dispatch: { en: "dispatch", hi: "रवानगी" },
  step_receive: { en: "receive", hi: "प्राप्ति" },
  step_confirm: { en: "confirm", hi: "पुष्टि" },
  outcome_granted: { en: "granted", hi: "मंज़ूर" },
  outcome_refused: { en: "refused", hi: "अस्वीकार" },
  summary: {
    en: "{step}: {outcome}; attempt {n}; deny reasons: {reasons}",
    hi: "{step}: {outcome}; प्रयास {n}; अस्वीकार के कारण: {reasons}",
  },
  none: { en: "none", hi: "कोई नहीं" },
  yes: { en: "yes", hi: "हाँ" },
  no: { en: "no", hi: "नहीं" },
  check_passed: { en: "passed", hi: "पास" },
  check_failed: { en: "failed", hi: "फ़ेल" },
  check_skipped: { en: "not evaluated", hi: "जाँचा नहीं गया" },
  leg_option: { en: "{no}: {from} → {to} ({id})", hi: "{no}: {from} → {to} ({id})" },
  leg_line: {
    en: "Leg {no}: {from} → {to}; dispatched: {dispatched}; key issued: {key}; completed: {completed}; refused attempts: {refused}; overdue: {overdue}",
    hi: "चरण {no}: {from} → {to}; रवाना: {dispatched}; चाबी जारी: {key}; पूरा: {completed}; अस्वीकार प्रयास: {refused}; देर: {overdue}",
  },
  legs_returned: { en: "{n} leg(s) returned by ledger.", hi: "लेजर ने {n} चरण लौटाए।" },
  chain_none: {
    en: "Chain event: not returned by engine for this step",
    hi: "चेन इवेंट: इस कदम के लिए इंजन ने नहीं लौटाया",
  },
  chain_recorded: { en: "Chain event {kind}: recorded {id}", hi: "चेन इवेंट {kind}: दर्ज {id}" },
  chain_not_recorded: { en: "Chain event {kind}: not recorded — {reason}", hi: "चेन इवेंट {kind}: दर्ज नहीं — {reason}" },
  no_reason: { en: "no reason returned", hi: "कारण नहीं लौटा" },
  key_held: {
    en: "Transfer key held in memory for leg {id}. It will be sent by Confirm and lost if this page closes.",
    hi: "चरण {id} की ट्रांसफ़र चाबी मेमोरी में रखी है। पुष्टि दबाने पर भेजी जाएगी; यह पेज बंद हुआ तो चली जाएगी।",
  },
  key_cleared: {
    en: "Transfer key consumed and cleared from memory.",
    hi: "ट्रांसफ़र चाबी इस्तेमाल हो गई और मेमोरी से हटा दी गई।",
  },

  // ── damaged label ──
  h_damaged: { en: "Damaged label", hi: "खराब लेबल" },
  p_damaged: {
    en: "After trying both codes, retain a photo and request a control-room decision. The hand-off stays blocked until approved.",
    hi: "दोनों कोड आज़माने के बाद फ़ोटो रखें और कंट्रोल रूम से फ़ैसला माँगें। मंज़ूरी मिलने तक सुपुर्दगी रुकी रहती है।",
  },
  l_leg_id: { en: "Leg ID", hi: "चरण आईडी" },
  l_seam: { en: "Seam ID typed from label", hi: "लेबल से देखकर लिखी सीम आईडी" },
  l_serial: { en: "Printed serial", hi: "छपा हुआ सीरियल" },
  l_seconds: { en: "Seconds spent trying both codes", hi: "दोनों कोड आज़माने में लगे सेकंड" },
  l_codes: { en: "Unreadable codes", hi: "जो कोड नहीं पढ़े गए" },
  o_both: { en: "Both", hi: "दोनों" },
  b_override: { en: "Request override using seal photo above", hi: "ऊपर की सील फ़ोटो के साथ ओवरराइड माँगें" },
  override_sent: {
    en: "Request {id} sent. Two control-room operators each have to see the packet on a video call from this phone before they can approve. ",
    hi: "अनुरोध {id} भेज दिया गया। मंज़ूरी से पहले कंट्रोल रूम के दो ऑपरेटरों को, हर एक को, इस फ़ोन से वीडियो कॉल पर पैकेट देखना होगा। ",
  },
  open_call: { en: "Open the video call", hi: "वीडियो कॉल खोलें" },

  // ── queue and photos ──
  h_queue: { en: "Offline queue", hi: "ऑफ़लाइन कतार" },
  b_sync: { en: "Sync now", hi: "अभी भेजें" },
  h_photos: { en: "Photos on this phone", hi: "इस फ़ोन पर फ़ोटो" },
  p_photos: {
    en: "Export these before clearing browser storage or replacing the phone.",
    hi: "ब्राउज़र का डेटा मिटाने या फ़ोन बदलने से पहले इन्हें निकाल लें।",
  },
  device: { en: "Device {id}", hi: "डिवाइस {id}" },
  not_enrolled: { en: "Phone not enrolled. Enrol while online.", hi: "फ़ोन दर्ज नहीं है। नेटवर्क रहते दर्ज करें।" },
  queue_count: { en: "{n} record(s) waiting to be sent", hi: "{n} रिकॉर्ड भेजे जाने बाक़ी" },
  queue_rejected: { en: ", {n} rejected and kept", hi: ", {n} अस्वीकार हुए और रखे गए" },
  export_damaged: { en: "Export damaged-label photo {id}…", hi: "खराब लेबल की फ़ोटो निकालें {id}…" },
  export_seal: { en: "Export seal photo {id}…", hi: "सील की फ़ोटो निकालें {id}…" },
  photo_kept: { en: "Photo retained on this phone. SHA-256 {hash}", hi: "फ़ोटो इस फ़ोन पर रखी गई है। SHA-256 {hash}" },
  net_down: { en: "Network unavailable. Signed records remain queued.", hi: "नेटवर्क नहीं है। हस्ताक्षरित रिकॉर्ड कतार में रहेंगे।" },
  accepted: { en: "{n} record(s) accepted by the ledger.", hi: "लेजर ने {n} रिकॉर्ड स्वीकार किए।" },
  rejected_by_ledger: { en: "Ledger rejected: {detail}", hi: "लेजर ने अस्वीकार किया: {detail}" },
  rejected_by_gateway: { en: "Gateway rejected: {detail}", hi: "गेटवे ने अस्वीकार किया: {detail}" },
  limited: {
    en: "The gateway is limiting this phone. Retry in {s} s; records stay queued.",
    hi: "गेटवे इस फ़ोन की रफ़्तार सीमित कर रहा है। {s} सेकंड बाद फिर कोशिश करें; रिकॉर्ड कतार में रहेंगे।",
  },
  a_few: { en: "a few", hi: "कुछ" },
  server_status: {
    en: "Server returned {status}. Remaining records stay queued.",
    hi: "सर्वर का जवाब {status} आया। बाक़ी रिकॉर्ड कतार में रहेंगे।",
  },

  // ── what has to be done first ──
  e_already_enrolled: { en: "This phone is already enrolled", hi: "यह फ़ोन पहले से दर्ज है" },
  e_ids_invalid: { en: "Enter valid exam, centre and person IDs", hi: "सही परीक्षा, केंद्र और व्यक्ति आईडी डालें" },
  e_need_operator: {
    en: "A control-room operator enters their username and password to enrol this phone",
    hi: "इस फ़ोन को दर्ज करने के लिए कंट्रोल रूम का ऑपरेटर अपना यूज़रनेम और पासवर्ड डालता है",
  },
  e_signin: { en: "Operator sign-in returned {status}", hi: "ऑपरेटर साइन-इन का जवाब {status} आया" },
  e_need_control_room: {
    en: "Enrolling a phone takes a control-room operator's account",
    hi: "फ़ोन दर्ज करने के लिए कंट्रोल रूम ऑपरेटर का खाता चाहिए",
  },
  e_cannot_read: { en: "Could not read {what} ({status})", hi: "{what} पढ़ा नहीं जा सका ({status})" },
  e_centre_not_of_exam: { en: "That centre is not a centre of that exam", hi: "वह केंद्र उस परीक्षा का केंद्र नहीं है" },
  e_person_unknown: { en: "No person on the register has that ID", hi: "रजिस्टर में उस आईडी का कोई व्यक्ति नहीं है" },
  e_enrol: { en: "Enrolment returned {status}", hi: "दर्ज करने का जवाब {status} आया" },
  enrolled: { en: "Enrolled. The operator's session has been ended.", hi: "दर्ज हो गया। ऑपरेटर का सत्र बंद कर दिया गया है।" },
  e_enrol_first: { en: "Enrol this phone first", hi: "पहले इस फ़ोन को दर्ज करें" },
  e_seq: { en: "Could not reserve a valid device sequence number", hi: "डिवाइस का सही क्रमांक सुरक्षित नहीं हो सका" },
  e_need_package: { en: "Enter the package ID above first", hi: "पहले ऊपर पैकेट आईडी डालें" },
  e_legs: { en: "Leg list returned {status}", hi: "चरणों की सूची का जवाब {status} आया" },
  e_need_live: { en: "A hand-off needs a live connection to the engine", hi: "सुपुर्दगी के लिए इंजन से चालू कनेक्शन चाहिए" },
  e_choose_leg: { en: "Load and choose a leg first", hi: "पहले चरण लाएँ और एक चुनें" },
  e_override_uuid: { en: "Override ID must be a UUID", hi: "ओवरराइड आईडी UUID होनी चाहिए" },
  e_need_qr: {
    en: "Scan both QR codes or enter an approved override ID",
    hi: "दोनों क्यूआर कोड स्कैन करें या मंज़ूर ओवरराइड आईडी डालें",
  },
  e_no_key: {
    en: "No transfer key held for this leg. It is only available in a granted receive response.",
    hi: "इस चरण की कोई ट्रांसफ़र चाबी नहीं रखी है। वह सिर्फ़ मंज़ूर हुई प्राप्ति के जवाब में मिलती है।",
  },
  e_handoff: { en: "Hand-off returned {status}", hi: "सुपुर्दगी का जवाब {status} आया" },
  e_need_live_cr: {
    en: "A damaged-label request needs a live control-room connection",
    hi: "खराब लेबल के अनुरोध के लिए कंट्रोल रूम से चालू कनेक्शन चाहिए",
  },
  e_leg_invalid: { en: "Enter a valid leg ID", hi: "सही चरण आईडी डालें" },
  e_need_seam: { en: "Type the seam ID still visible on the label", hi: "लेबल पर जो सीम आईडी अब भी दिख रही है वह लिखें" },
  e_need_photo_damaged: { en: "Take the damaged-label photograph first", hi: "पहले खराब लेबल की फ़ोटो लें" },
  e_need_seconds: { en: "Enter seconds spent trying the codes", hi: "कोड आज़माने में लगे सेकंड डालें" },
  e_override: { en: "Override request returned {status}", hi: "ओवरराइड अनुरोध का जवाब {status} आया" },
  e_package_invalid: { en: "Enter a valid package ID", hi: "सही पैकेट आईडी डालें" },
  e_need_photo_seal: { en: "Take the seal photograph first", hi: "पहले सील की फ़ोटो लें" },
  e_need_identifier: { en: "Scan a QR or enter its identifier", hi: "क्यूआर स्कैन करें या उसकी पहचान लिखें" },

  // ── the video call page ──
  c_back: { en: "back to scans", hi: "स्कैन पर वापस" },
  c_h: { en: "Show a damaged label to the control room", hi: "खराब लेबल कंट्रोल रूम को दिखाएँ" },
  c_p1: {
    en: "Two control room operators each have to see the packet, its label and both officers on a live call before they can approve a damaged-label request. This opens that call from this phone's camera.",
    hi: "खराब लेबल का अनुरोध मंज़ूर करने से पहले कंट्रोल रूम के दो ऑपरेटरों को, हर एक को, चालू कॉल पर पैकेट, उसका लेबल और दोनों अधिकारी देखने होते हैं। यह पेज इस फ़ोन के कैमरे से वही कॉल खोलता है।",
  },
  c_p2: {
    en: "The picture goes from this phone straight to each operator's screen. It is not recorded and the ledger does not see it; the ledger records that the call connected.",
    hi: "तस्वीर इस फ़ोन से सीधे हर ऑपरेटर की स्क्रीन पर जाती है। वह रिकॉर्ड नहीं होती और लेजर उसे नहीं देखता; लेजर सिर्फ़ यह दर्ज करता है कि कॉल जुड़ी।",
  },
  c_request: { en: "Request", hi: "अनुरोध" },
  c_open: { en: "Open the camera and call", hi: "कैमरा खोलें और कॉल करें" },
  c_close: { en: "Close the call", hi: "कॉल बंद करें" },
  c_not_enrolled: {
    en: "This phone is not enrolled. Enrol it on the main screen first.",
    hi: "यह फ़ोन दर्ज नहीं है। पहले मुख्य स्क्रीन पर इसे दर्ज करें।",
  },
  c_live: {
    en: "On the call with {names}. Hold the packet, its label and both officers in view.",
    hi: "{names} के साथ कॉल चालू है। पैकेट, उसका लेबल और दोनों अधिकारी कैमरे में रखें।",
  },
  c_and: { en: " and ", hi: " और " },
  c_calling: { en: "Calling the control room…", hi: "कंट्रोल रूम को कॉल की जा रही है…" },
  c_waiting: {
    en: "Camera on. Waiting for a control room operator to open the call from their side.",
    hi: "कैमरा चालू है। कंट्रोल रूम के ऑपरेटर के अपनी तरफ़ से कॉल खोलने का इंतज़ार है।",
  },
  c_an_operator: { en: "an operator", hi: "एक ऑपरेटर" },
  c_failed: {
    en: "This phone and the control room could not reach each other directly. There is no relay server, so a network that blocks direct connections stops the call. Try another network.",
    hi: "यह फ़ोन और कंट्रोल रूम एक-दूसरे तक सीधे नहीं पहुँच सके। कोई रिले सर्वर नहीं है, इसलिए सीधा कनेक्शन रोकने वाला नेटवर्क कॉल रोक देता है। दूसरा नेटवर्क आज़माएँ।",
  },
  c_failed_relay: {
    en: "This phone and the control room could not reach each other, directly or through the relay. Tell the control room; the relay may be down.",
    hi: "यह फ़ोन और कंट्रोल रूम एक-दूसरे तक न सीधे पहुँच सके, न रिले के रास्ते। कंट्रोल रूम को बताएँ; हो सकता है रिले बंद हो।",
  },
  c_no_request: {
    en: "This phone has no damaged-label request to call about. Make the request on the main screen first.",
    hi: "इस फ़ोन का कोई खराब लेबल अनुरोध नहीं है जिस पर कॉल हो। पहले मुख्य स्क्रीन पर अनुरोध करें।",
  },
  c_no_camera: {
    en: "This browser cannot open a camera. The call needs one.",
    hi: "यह ब्राउज़र कैमरा नहीं खोल सकता। कॉल के लिए कैमरा चाहिए।",
  },
  c_asking: { en: "Asking for the camera…", hi: "कैमरे की अनुमति माँगी जा रही है…" },
  c_closed: { en: "Call closed.", hi: "कॉल बंद हो गई।" },
  c_none_today: {
    en: "This phone has made no damaged-label request in the last day.",
    hi: "इस फ़ोन ने पिछले एक दिन में कोई खराब लेबल अनुरोध नहीं किया।",
  },
  c_no_sdp: { en: "The browser produced no connection description", hi: "ब्राउज़र ने कनेक्शन का विवरण नहीं बनाया" },
  c_option: {
    en: "{serial} · leg {no}: {from} to {to} · {standing}",
    hi: "{serial} · चरण {no}: {from} से {to} · {standing}",
  },
  c_packet: { en: "packet", hi: "पैकेट" },
  c_refused: { en: "refused", hi: "अस्वीकार" },
  c_approvals: { en: "{n} of 2 approvals", hi: "2 में से {n} मंज़ूरी" },
} as const;

export type Key = keyof typeof STRINGS;

const STORE = "mohar.field.lang";

function initial(): Lang {
  try {
    const kept = localStorage.getItem(STORE);
    if (kept === "en" || kept === "hi") return kept;
  } catch {
    // Storage can be blocked; the phone's own language decides then.
  }
  return navigator.language?.toLowerCase().startsWith("hi") ? "hi" : "en";
}

let current: Lang = initial();

export const lang = (): Lang => current;

/** One line, in the language in use, with `{name}` places filled in. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
  return STRINGS[key][current].replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Put the words into every element that names a line. */
export function applyLanguage(root: ParentNode = document): void {
  document.documentElement.lang = current;
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset["i18n"] as Key);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset["i18nPlaceholder"] as Key);
  }
}

/**
 * The button that switches language. It names the language it switches to, in
 * that language, so someone who cannot read the current one can find it.
 */
export function languageButton(onChange: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lang";
  const label = () => {
    button.textContent = current === "en" ? "हिन्दी" : "English";
    button.lang = current === "en" ? "hi" : "en";
  };
  label();
  button.addEventListener("click", () => {
    current = current === "en" ? "hi" : "en";
    try {
      localStorage.setItem(STORE, current);
    } catch {
      // Not remembered across visits, then; it still switches now.
    }
    label();
    applyLanguage();
    onChange();
  });
  return button;
}
