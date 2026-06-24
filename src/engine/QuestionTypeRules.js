/* ═══════════════════════════════════════════════════════════════
   QuestionTypeRules.js — Static config for all word-test question types
   One entry per type: what fields required, which distractor strategy,
   option type, min pool size, and display strings.
═══════════════════════════════════════════════════════════════ */

const QUESTION_TYPE_RULES = {

  listen_pick_picture: {
    label:               'Listen → Pick Picture',
    label_mr:            'ऐका → चित्र निवडा',
    question_template:   'Listen and pick the correct picture.',
    audio:               true,
    requires_fields:     ['image_url'],
    requires_category:   null,
    distractor_strategy: 'same_subject_images',
    option_type:         'image',
    option_count:        4,
    min_pool_size:       4,
    answer_field:        'image_url',
  },

  listen_choose_word: {
    label:               'Listen → Choose Word',
    label_mr:            'ऐका → शब्द निवडा',
    question_template:   'Listen and choose the correct word.',
    audio:               true,
    requires_fields:     [],
    requires_category:   null,
    distractor_strategy: 'same_subject_words',
    option_type:         'text',
    option_count:        4,
    min_pool_size:       4,
    answer_field:        'word',
  },

  listen_meaning_mr: {
    label:               'Listen → Meaning (MR)',
    label_mr:            'ऐका → अर्थ निवडा (मराठी)',
    question_template:   'Listen and choose the Marathi meaning.',
    audio:               true,
    requires_fields:     ['meaning_mr'],
    requires_category:   null,
    distractor_strategy: 'same_subject_meanings_mr',
    option_type:         'text',
    option_count:        4,
    min_pool_size:       4,
    answer_field:        'meaning_mr',
  },

  listen_meaning_en: {
    label:               'Listen → Meaning (EN)',
    label_mr:            'ऐका → अर्थ निवडा (English)',
    question_template:   'Listen and choose the English meaning.',
    audio:               true,
    requires_fields:     ['meaning_en'],
    requires_category:   null,
    distractor_strategy: 'same_subject_meanings_en',
    option_type:         'text',
    option_count:        4,
    min_pool_size:       4,
    answer_field:        'meaning_en',
  },

  listen_spelling: {
    label:               'Listen → Spelling',
    label_mr:            'ऐका → Spelling निवडा',
    question_template:   'Listen and choose the correct spelling.',
    audio:               true,
    requires_fields:     [],
    requires_category:   null,
    distractor_strategy: 'wrong_spelling_gen',
    option_type:         'text',
    option_count:        4,
    min_pool_size:       1,
    answer_field:        'word',
  },

  listen_type_word: {
    label:               'Listen → Type Word',
    label_mr:            'ऐका → शब्द लिहा',
    question_template:   'Listen and type the word you hear.',
    audio:               true,
    requires_fields:     [],
    requires_category:   null,
    distractor_strategy: null,
    option_type:         'typing',
    option_count:        0,
    min_pool_size:       1,
    answer_field:        'word',
  },

  listen_pick_colour: {
    label:               'Listen → Pick Colour',
    label_mr:            'ऐका → रंग निवडा',
    question_template:   'Listen and pick the correct colour.',
    audio:               true,
    requires_fields:     [],
    requires_category:   'color',
    distractor_strategy: 'fixed_color_pool',
    option_type:         'colour',
    option_count:        4,
    min_pool_size:       1,
    answer_field:        'word',
  },

  listen_pick_alphabet: {
    label:               'Listen → Pick Letter',
    label_mr:            'ऐका → अक्षर निवडा',
    question_template:   'Listen and pick the correct letter.',
    audio:               true,
    requires_fields:     [],
    requires_category:   'alphabet',
    distractor_strategy: 'fixed_alphabet_pool',
    option_type:         'text',
    option_count:        4,
    min_pool_size:       1,
    answer_field:        'word',
  },

  listen_pick_number: {
    label:               'Listen → Pick Number',
    label_mr:            'ऐका → अंक निवडा',
    question_template:   'Listen and pick the correct number.',
    audio:               true,
    requires_fields:     [],
    requires_category:   'number',
    distractor_strategy: 'fixed_number_pool',
    option_type:         'text',
    option_count:        4,
    min_pool_size:       1,
    answer_field:        'word',
  },

  word_meaning_mr: {
    label:               'Word → Meaning (MR)',
    label_mr:            'शब्द वाचा → अर्थ निवडा',
    question_template:   'What is the Marathi meaning of this word?',
    audio:               false,
    requires_fields:     ['meaning_mr'],
    requires_category:   null,
    distractor_strategy: 'same_subject_meanings_mr',
    option_type:         'text',
    option_count:        4,
    min_pool_size:       4,
    answer_field:        'meaning_mr',
  },
};

// Fixed pools for special category types
const COLOR_POOL = [
  { text: 'Red',    colour: '#E53935' },
  { text: 'Blue',   colour: '#1E88E5' },
  { text: 'Green',  colour: '#43A047' },
  { text: 'Yellow', colour: '#FDD835' },
  { text: 'Orange', colour: '#FB8C00' },
  { text: 'Purple', colour: '#8E24AA' },
  { text: 'Pink',   colour: '#E91E63' },
  { text: 'White',  colour: '#F5F5F5' },
  { text: 'Black',  colour: '#212121' },
  { text: 'Brown',  colour: '#6D4C41' },
];

const ALPHABET_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => ({ text: l }));

const NUMBER_POOL   = ['1','2','3','4','5','6','7','8','9','10',
                        '11','12','13','14','15','16','17','18','19','20']
                      .map(n => ({ text: n }));

module.exports = { QUESTION_TYPE_RULES, COLOR_POOL, ALPHABET_POOL, NUMBER_POOL };
