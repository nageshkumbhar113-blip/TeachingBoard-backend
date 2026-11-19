// "नियम आणि धोरण" every teacher who receives bulk-imported students must accept (web page
// /teacher-rules, and the PDF given with the students' codes and PINs). One source of truth:
// the page, the PDF and the acceptance record all use RULES_VERSION from here.
// Change the text → bump the version → teachers are asked to accept again.

const RULES_VERSION = 'teacher-rules-v2';   // v2 2026-11-19: सूट when the teacher pays; teachers make accounts in the app

const RULES = {
  version: RULES_VERSION,
  title: 'शिक्षकांसाठी नियम आणि धोरण',
  owner: 'NKs EduOrbit (TeachingBoard)',
  updated: '2026-11-20',
  sections: [
    {
      title: '1. विद्यार्थी आणि मुदत',
      points: [
        'तुमच्या विद्यार्थ्यांची accounts तुम्ही Teacher app मधून (पैसे भरून) बनवू शकता, किंवा admin बनवतो. प्रत्येक विद्यार्थ्याची मुदत (expiry) त्याच्या plan नुसार असते — Monthly (30 दिवस) किंवा Yearly (30 एप्रिल पर्यंत).',
        'तुम्ही बनवलेले विद्यार्थी आपोआप तुमच्याशी जोडले जातात. विद्यार्थ्याचे नाव / mobile बदलणे किंवा account काढणे फक्त admin करू शकतो.',
        'विद्यार्थ्याची मुदत संपली तरी तुमचे शिक्षक account बंद होत नाही.',
        'Bulk विद्यार्थी जोडल्यानंतर त्या courses साठी Paper बनवण्याची मर्यादा 30 एप्रिल पर्यंत नसते (unlimited). 30 एप्रिल नंतर नेहमीची मर्यादा आपोआप लागू होते.'
      ]
    },
    {
      title: '2. Payment आणि discount',
      points: [
        'पैसे पूर्ण भरल्यावरच accounts तयार होतात.',
        'तुम्ही विद्यार्थ्यांसाठी पैसे भरता तेव्हा admin ने तुमच्यासाठी ठरवलेली सूट (% किंवा ₹) course च्या किमतीतून आधीच कमी होते; ती रक्कम app मध्ये पैसे भरण्याआधी दिसते.',
        'ही सूट फक्त तुम्ही स्वतः पैसे भरता तेव्हाच लागते. विद्यार्थी / पालक स्वतः पैसे भरतात तेव्हा तुम्हाला कोणतीही रक्कम मिळत नाही.',
        'आधीच तोच course चालू असलेल्या विद्यार्थ्यासाठी पैसे घेतले जात नाहीत; तो फक्त तुमच्याशी जोडला जातो.'
      ]
    },
    {
      title: '3. Account चा वापर',
      points: [
        'प्रत्येक विद्यार्थ्याचा code आणि PIN फक्त त्याच विद्यार्थ्यासाठी आहे. ते दुसऱ्याला देणे, विकणे किंवा एकच account अनेक जणांनी वापरणे मना आहे.',
        'तुमचा शिक्षक code आणि PIN गुप्त ठेवा. तुमच्या account मधून झालेल्या प्रत्येक कृतीची जबाबदारी तुमची आहे.'
      ]
    },
    {
      title: '4. Copyright आणि content चा वापर',
      points: [
        'App मधील सर्व प्रश्न, papers, उत्तरे, उकल, notes, आकृत्या आणि इतर साहित्य NKs EduOrbit (TeachingBoard) ची मालमत्ता आहे आणि copyright कायद्याने संरक्षित आहे.',
        'हे साहित्य फक्त तुमच्या स्वतःच्या वर्गात / विद्यार्थ्यांना शिकवण्यासाठी वापरता येईल.',
        'हे साहित्य वापरून पुस्तक, guide, question bank, PDF किंवा notes तयार करून विकणे, छापून वाटणे, किंवा दुसऱ्या app, website, YouTube, Telegram, WhatsApp group वर टाकणे पूर्णपणे मना आहे.',
        'Download केलेल्या papers वर तुमचे नाव / code असू शकते; त्यावरून ते कोणाकडून बाहेर गेले हे ओळखता येते.'
      ]
    },
    {
      title: '5. गैरवापर झाल्यास',
      points: [
        'वरील नियमांचा भंग झाल्यास तुमचे account आणि संबंधित विद्यार्थ्यांचे access ताबडतोब बंद केले जाऊ शकते.',
        'अशा वेळी तुमची सूट बंद केली जाऊ शकते.',
        'Copyright भंग किंवा फसवणुकीसाठी लागू कायद्यानुसार कायदेशीर कारवाई करण्याचा हक्क NKs EduOrbit राखून ठेवते.'
      ]
    },
    {
      title: '6. विद्यार्थ्यांची माहिती (Privacy)',
      points: [
        'विद्यार्थ्यांची नावे, mobile नंबर आणि निकाल फक्त शिकवण्यासाठी वापरा. ही माहिती विकणे, जाहिरातीसाठी वापरणे किंवा दुसऱ्याला देणे मना आहे.'
      ]
    },
    {
      title: '7. नियमांमध्ये बदल',
      points: [
        'हे नियम वेळोवेळी बदलू शकतात. नवीन version आल्यावर ते पुन्हा मान्य करावे लागतील; मान्य करेपर्यंत Paper बनवणे थांबू शकते.',
        'App किंवा हे accounts वापरणे सुरू ठेवल्यास हे नियम मान्य आहेत असे समजले जाईल.'
      ]
    }
  ],
  agreeText: 'मी हे सर्व नियम वाचले आहेत आणि ते मला मान्य आहेत.'
};

/** True when this teacher must (still) accept the current rules. */
function rulesPending(teacher) {
  return Boolean(teacher && teacher.rules_required && teacher.rules_version_accepted !== RULES_VERSION);
}

const RULES_URL = 'https://nkseduorbit.in/teacher-rules';

module.exports = { RULES_VERSION, RULES, RULES_URL, rulesPending };
