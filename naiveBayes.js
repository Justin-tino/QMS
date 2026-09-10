/**
 * PSAU Feedback System — Trilingual Naïve Bayes Sentiment Classifier
 * Implements a local Multinomial Naïve Bayes text classification algorithm
 * trained on English, Tagalog (Filipino), and Kapampangan sentiment corpora.
 * Supports adaptive persistence and incremental online learning via Firestore.
 */

class NaiveBayesSentimentClassifier {
    constructor() {
        this.categories = ['Positive', 'Negative', 'Neutral', 'Mixed'];
        this.vocabulary = new Set();
        this.wordCounts = {
            Positive: {},
            Negative: {},
            Neutral: {},
            Mixed: {}
        };
        this.totalWordCounts = {
            Positive: 0,
            Negative: 0,
            Neutral: 0,
            Mixed: 0
        };
        this.docCounts = {
            Positive: 0,
            Negative: 0,
            Neutral: 0,
            Mixed: 0
        };
        this.totalDocs = 0;

        // Model version — bump this whenever the seed corpus changes.
        // Persisted states from older versions are ignored on load to prevent
        // poisoned/legacy training data from overriding the fresh seed corpus.
        this.modelVersion = 5;

        // Initialize with trained trilingual sentiment dictionary
        this.seedCorpus();
    }

    /**
     * Export current model state into a serializable plain JavaScript object for Firestore storage
     */
    exportModelState() {
        return {
            modelVersion: this.modelVersion,
            vocabulary: Array.from(this.vocabulary),
            wordCounts: this.wordCounts,
            totalWordCounts: this.totalWordCounts,
            docCounts: this.docCounts,
            totalDocs: this.totalDocs,
            updatedAt: new Date().toISOString()
        };
    }

    /**
     * Load state into classifier instance from serialized Firestore data
     */
    loadModelState(data) {
        if (!data) return;

        // Guard against stale/poisoned states: if the persisted state was saved
        // by an older model version (different seed corpus), discard it and keep
        // the fresh seed corpus instead. It will be overwritten on the next save.
        if (data.modelVersion !== this.modelVersion) {
            console.log(` Skipping stale ML model state (v${data.modelVersion || 1}) — current model version is v${this.modelVersion}. Using fresh seed corpus.`);
            return;
        }

        if (Array.isArray(data.vocabulary)) {
            this.vocabulary = new Set(data.vocabulary);
        }
        if (data.wordCounts) {
            this.categories.forEach(cat => {
                if (data.wordCounts[cat]) {
                    this.wordCounts[cat] = { ...data.wordCounts[cat] };
                }
            });
        }
        if (data.totalWordCounts) {
            this.categories.forEach(cat => {
                if (typeof data.totalWordCounts[cat] === 'number') {
                    this.totalWordCounts[cat] = data.totalWordCounts[cat];
                }
            });
        }
        if (data.docCounts) {
            this.categories.forEach(cat => {
                if (typeof data.docCounts[cat] === 'number') {
                    this.docCounts[cat] = data.docCounts[cat];
                }
            });
        }
        if (typeof data.totalDocs === 'number') {
            this.totalDocs = data.totalDocs;
        }
    }

    /**
     * Light multilingual stemmer — collapses word variants to a shared stem so the
     * classifier "understands" inflected forms it has never literally seen.
     *   Tagalog: napakaganda/magandang/maganda → ganda | matulungin/tumulong → tulung
     *            mabagal/kabagalan → bagal | salamat pasasalamat → salamat
     *   Kapampangan: mabagut/bagut → bagut | pamangaintay/pamag-antay → antay
     *   English: waited/waiting/waits → wait | rude/rudeness → rude
     * Affix stripping only (no aggressive stemming) — avoids over-merging in agglutinative Filipino morphology.
     */
    stem(word) {
        let w = word;
        if (w.length <= 3) return w;

        // --- Common Filipino affixes (longest first) ---
        const prefixes = ['nakakapang', 'nakakapag', 'makapag', 'nagpapa', 'pinaka', 'napaka', 'nakaka', 'nagka', 'nagpa', 'magpa', 'mang', 'nang', 'nag', 'mag', 'man', 'ma', 'pa', 'ka', 'na'];
        // Verb-focus prefixes ("mag" = to do X). "maganda" (beautiful) is NOT mag+anda —
        // when one of these precedes a VOWEL, skip it so adjective roots stay intact
        // (maganda/magandang → ganda via the shorter 'ma' prefix instead).
        const verbFocus = new Set(['nag', 'mag', 'magpa', 'nagpa', 'makapag', 'nakakapag', 'nakakapang', 'nagpapa', 'nagka']);
        for (const p of prefixes) {
            if (w.startsWith(p) && w.length - p.length >= 3) {
                if (verbFocus.has(p) && /[aeiou]/.test(w[p.length] || '')) continue;
                w = w.slice(p.length);
                break;
            }
        }

        // --- English derivational suffixes ---
        const enSuffixes = [['ingly', 2], ['edly', 2], ['ies', 'y'], ['iness', 'y'], ['ments', ''], ['ment', ''], ['ness', ''], ['ful', ''], ['ing', ''], ['ies', 'y'], ['ied', 'y'], ['ers', ''], ['er', ''], ['est', ''], ['ed', ''], ['ly', ''], ['s', '']];
        for (const [s, rep] of enSuffixes) {
            if (w.endsWith(s) && w.length - s.length >= 3) {
                w = w.slice(0, w.length - s.length) + (rep === 2 ? w.slice(w.length - s.length + 1) : rep);
                break;
            }
        }

        // --- Filipino suffixes (linkers & aspect markers) ---
        const filSuffixes = [['han', ''], ['hın', ''], ['an', ''], ['in', ''], ['ng', '']];
        for (const [s, rep] of filSuffixes) {
            if (w.endsWith(s) && w.length - s.length >= 3) {
                w = w.slice(0, w.length - s.length) + rep;
                break;
            }
        }

        // --- Kapampangan suffixes ---
        if (w.endsWith('an') && w.length >= 5) w = w.slice(0, -2);

        // --- Filipino reduplication removal (bumibilis → bilis, nagmamadali → madali) ---
        if (w.length >= 6 && w[0] === w[2] && w[1] === w[3]) {
            w = w.slice(2);
        }

        return w;
    }

    /**
     * Clean and tokenize input text into n-grams (unigrams & bigrams)
     * Supports English, Tagalog, and Kapampangan character sets.
     * Unigrams are stemmed; bigrams keep original surface forms for context.
     */
    tokenize(text) {
        if (!text || typeof text !== 'string') return [];

        const cleaned = text
            .toLowerCase()
            .replace(/[^\w\sñgÑGáéíóúàèìòùâêîôûäëïöü]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const words = cleaned.split(' ').filter(w => w.length > 1);
        const stemmed = words.map(w => this.stem(w));

        // Stemmed unigrams (generalize across inflected variants)
        const tokens = [...stemmed];

        // Bigrams from original surface words for context (e.g. "hindi mabait", "dakal a salamat")
        for (let i = 0; i < words.length - 1; i++) {
            tokens.push(`${words[i]}_${words[i + 1]}`);
        }

        return tokens;
    }

    /**
     * Train the classifier with a document and its labeled category
     */
    train(text, category) {
        if (!this.categories.includes(category)) return;

        const tokens = this.tokenize(text);
        if (tokens.length === 0) return;

        this.docCounts[category]++;
        this.totalDocs++;

        tokens.forEach(token => {
            this.vocabulary.add(token);
            this.wordCounts[category][token] = (this.wordCounts[category][token] || 0) + 1;
            this.totalWordCounts[category]++;
        });
    }

    /**
     * Incrementally train the classifier with new feedback text and predicted/verified sentiment
     */
    incrementalTrain(text, category) {
        if (!text || typeof text !== 'string' || !text.trim()) return;
        if (!this.categories.includes(category)) return;

        // Guard against label noise: very short feedbacks (e.g. "okay naman",
        // "salamat lang") are highly ambiguous. Learning them into a single
        // category caused short neutral phrases to be permanently biased
        // (self-training feedback loop). Require a minimal token signal.
        if (this.tokenize(text).length < 4) return;

        this.train(text, category);
    }

    /**
     * Seed initial trilingual dataset (English, Tagalog, Kapampangan)
     */
    seedCorpus() {
        const corpus = {
            Positive: [
                // Tagalog
                "maganda ang serbisyo mabilis at maayos",
                "mabait ang mga tauhan at matulungin",
                "napakaganda ng pamamalakad maraming salamat",
                "mabilis ang pagproseso ng aking mga dokumento",
                "kasiya siya ang naging karanasan ko sa opisinang ito",
                "napakahusay ng opisyal at maasikaso",
                "malinis at maayos ang tanggapan",
                "mura at makatarungan ang bayarin",
                "masaya ako sa mabilis na pag-asikaso",
                "salamat sa magandang pagtrato sa amin",
                "mabilis magproseso hindi nagpapatagal",
                "okay naman po ang serbisyo salamat",
                "okay lang po salamat sa tulong",
                "salamat po sa maayos na serbisyo",
                "okay na okay ang pagkaka-asikaso",
                "walang problema salamat po",
                "okay naman salamat",
                "ok lang po salamat",

                // Kapampangan
                "mayap a serbisyu mabilis at santing",
                "dakal a salamat king masanting a pamangasiwa",
                "malamis at mausig la reng empleyadu",
                "mabilis ing prosesu at santing ing resulta",
                "masanting a lugal at maayos ing sistema",
                "mayap la pamanangap kaku king opisina",
                "dakal a salamat maasikaso la ngan",
                // Kapampangan affirmative acknowledgments ("okay lang/mu" = affirming "good")
                "okay yamu",
                "ok yamu",
                "okay mu",
                "ok mu",
                "okay yamu salamat",
                "ok mu pu dakal a salamat",
                "mayap yamu",
                "mayap mu salamat",
                "okay la reng tauan salamat",
                "mayap ya ing serbisyu dakal a salamat",
                "ok la pu salamat",

                // English
                "excellent service very fast and polite staff",
                "great experience smooth process helpful personnel",
                "awesome work efficient and clean facility",
                "courteous employees quick document release",
                "satisfied with the service outcome high quality",
                "prompt response and friendly reception",
                "very easy transaction hassle free process",
                "outstanding assistance from the university team",
                "okay thank you very much",
                "ok thanks good job",
                "all good thank you",
                "good service thanks",
                // Kapampangan "I was able to avail" compliment patterns ("Ang ganda ng service, aburyan ke")
                "ang ganda ng service aburyan ke",
                "ang ganda ng serbisyo abyuran ke",
                "ang ganda ng service",
                "ang ganda ng serbisyo",
                "ganda ng service aburyan ke",
                "abyuran ke",
                "aburyan ke",
                "abyuran ke ing serbisyu",
                "aburyan ke pu",
                "ganda ing serbisyu abyuran ke",
                "mayap ing serbisyu aburyan ke",
                "napakabait ng staff napakabilis ng serbisyo",
                "napakabait ng mga empleyado napakagalang at matulungin",
                "mabait ang staff at napakabilis mag-asikaso",
                "napakagalang ng mga empleyado mabilis ang transaksyon",
                "bait ng staff galang mabilis at maayos",
                "napakabait ng nag-asikaso sa akin",
                "the staff were very accommodating and helpful",
                "very accommodating staff and quick process",
                "friendly and courteous employees fast service"
            ],
            Negative: [
                // Tagalog
                "mabagal ang pagproseso matagal mag-antay",
                "masungit ang mga tauhan at hindi matulungin",
                "nakakadismaya ang serbisyo bastos makipag-usap",
                "pangit ang sistema walang disiplina ang empleyado",
                "mahal ang singil at maraming palakasan",
                "ang tagal bago makuha ang kailangang papel",
                "perwisyo sa oras walang pakialam sa kliyente",
                "pabaya ang opisina at paulit ulit ang pinaaasikaso",

                // Kapampangan
                "mabagut at marok ing pamangasiwa",
                "malwat ing pamangaintay mabagal la mag-obra",
                "matsura la ugali reng tauan masaguit makiusap",
                "makadismaya ing serbisyu ali mayap",
                "mabayat at masaguit ing prosesu",

                // English
                "very slow service long waiting time disappointing",
                "rude staff unhelpful and arrogant attitude",
                "poor organization terrible line system waste of time",
                "frustrating experience bad customer treatment",
                "expensive fees for simple transaction delay",
                "horrible assistance nobody knows what to do",
                "bagal ng serbisyo",
                "bagal ng proseso",
                "bagal nila mag-asikaso",
                "antagal ng serbisyo",
                "antagal bago mabigyan ng papers",
                "napakabagal ng linya napakabagal ng serbisyo",
                "napakabagal ng proseso at matagal mag-antay"
            ],
            Neutral: [
                // Tagalog / Kapampangan / English
                "sakto lang ang oras ng pagproseso",
                "karaniwang serbisyo katamtaman lang",
                "walang masyadong problema saktong pag-asikaso",
                "normal lang ang pila at oras ng pag-antay",
                "sakto mu ing oras ning pamangaintay",
                "average service acceptable processing time",
                "standard procedure completed as expected",
                "neither bad nor good just fine",
                "walang masyadong problema saktong pag-asikaso",
                "normal lang ang pila at oras ng pag-antay",
                "sakto mu ing oras ning pamangaintay",
                "karaniwan mu ing karanasan king opisina",
                // Positive comments that include an improvement suggestion -> Neutral
                "maganda ang serbisyo pero sana dagdagan pa ang counters",
                "maganda ang serbisyo pero sana mas marami pa ang staff",
                "mabilis po sana mas marami pa ang staff",
                "maganda po sana mas mapapabilis pa ang proseso",
                "mabilis ang proseso pero sana mas lumawak pa ang parking",
                "good service but please add more seating",
                "good service but the waiting area needs more chairs",
                "great staff but the waiting area could be improved",
                "fast processing but more payment windows would help",
                // Polite suggestions without any complaint -> Neutral
                "sana linisin pa ang comfort room",
                "sana po palawakin pa ang oras ng serbisyo",
                "sana magkaroon ng mas maraming window",
                "sana po may mas malaking waiting area",
                "sana dagdagan pa po ang tauhan sa tanggapan",
                "sana may online appointment para hindi na mag-antay",
                "sana po magkaroon ng mas maraming signages",
                "i hope you can improve your online system",
                "it would be better if there is an appointment option",
                "i suggest adding more staff at the counter",
                "please improve the online booking system",
                "i wish there were more payment channels",
                "the service is good but i suggest adding more staff",
                "good system but please consider adding more windows",
                "everything went well but the room needs better ventilation",
                // Kapampangan positive + polite suggestion -> Neutral
                "mayap ing serbisyu pero sana dagdagan la ring tauan",
                "mayap ya pero sana mas lumwat pa ing lugal pamag-antay",
                "mabilis ing prosesu pero sana misan mas dakal pa reng tao",
                "sana misan mas mabilis la reng tauan kung maliari mu pu",
                "sana mas mabilis la reng tauan",
                "sana dagdagan la reng tauan kung maliari",
                "sana dakal pa reng tauan king opisina"
            ],
            Mixed: [
                "mabilis ang serbisyo pero medyo masungit ang staff",
                "mabait ang empleyado pero napakamabagal ng linya",
                "maganda ang opisina ngunit matagal ang pag-antay",
                "fast processing but rude front desk response",
                "good facility but delayed release of documents",
                "mayap ing opisina pero malwat ing pila",
                "mabilis ang serbisyo pero masungit ang staff",
                "mabilis ang serbisyo ngunit masungit ang empleyado",
                "maganda ang serbisyo pero maluwag ang system",
                "helpful staff but very slow document processing",
                "mayap ya pero misan malwat ing pamangaintay",
                "mayap ing serbisyu pero misan malwat la reng pila",
                "the staff were friendly but the waiting time was too long",
                "friendly staff but slow service",
                "the employees are nice but the process takes too long",
                "staff were polite but the queue was poorly organized",
                "mabilis ing prosesu pero masaguit ya ing tauan",
                "maasikaso la reng tauan pero malwat ing pamangaintay",
                "santing la reng tauan pero mabagal ing prosesu"
            ]
        };

        Object.keys(corpus).forEach(category => {
            corpus[category].forEach(text => this.train(text, category));
        });
    }

    /**
     * Classify input text using Multinomial Naïve Bayes formula:
     * P(Category|Text) ∝ P(Category) * ∏ P(Word|Category)
     * Log probabilities are used to prevent underflow.
     */
    classify(text) {
        const tokens = this.tokenize(text);

        // If text is empty or has no valid tokens, return default Neutral
        if (tokens.length === 0) {
            return {
                sentiment: 'Neutral',
                confidence: 0.5,
                scores: { Positive: 0.25, Negative: 0.25, Neutral: 0.25, Mixed: 0.25 }
            };
        }

        const vocabSize = Math.max(this.vocabulary.size, 1);
        const logScores = {};

        this.categories.forEach(category => {
            // Prior probability P(Category)
            const prior = (this.docCounts[category] || 1) / (this.totalDocs || 1);
            let logProb = Math.log(prior);

            // Likelihood ∏ P(Word|Category) with Laplace (+1) smoothing
            const totalWordsInCat = this.totalWordCounts[category] || 0;
            tokens.forEach(token => {
                const count = (this.wordCounts[category] && this.wordCounts[category][token]) || 0;
                const wordProb = (count + 1) / (totalWordsInCat + vocabSize);
                logProb += Math.log(wordProb);
            });

            logScores[category] = logProb;
        });

        // Convert log scores to normalized probabilities using Softmax
        const maxLog = Math.max(...Object.values(logScores));
        const expScores = {};
        let sumExp = 0;

        this.categories.forEach(cat => {
            expScores[cat] = Math.exp(logScores[cat] - maxLog);
            sumExp += expScores[cat];
        });

        const normalizedScores = {};
        let winner = 'Neutral';
        let maxScore = -Infinity;

        this.categories.forEach(cat => {
            normalizedScores[cat] = parseFloat((expScores[cat] / sumExp).toFixed(4));
            if (normalizedScores[cat] > maxScore) {
                maxScore = normalizedScores[cat];
                winner = cat;
            }
        });

        return {
            sentiment: winner,
            confidence: maxScore,
            scores: normalizedScores
        };
    }

    /**
     * Detects whether a comment contains a suggestion / request for improvement.
     * Multilingual keyword heuristics: English, Tagalog, and Kapampangan.
     */
    detectImprovementSuggestion(text) {
        if (!text || typeof text !== 'string') return false;
        const t = ` ${text.toLowerCase()} `;
        const patterns = [
            // English
            /\bsuggest/i, /\bsuggestion/i, /\bimprove/i, /\bimprovement/i,
            /\bhope/i, /\bwish/i, /\bshould be\b/i, /\bcould be\b/i,
            /\bplease (add|provide|fix|consider)\b/i, /\bi (hope|wish|suggest)\b/i,
            /\bneed(s)? (to|more|to be)\b/i, /\bmore (staff|chairs|windows|counter|slots)\b/i,
            /\bi recommend\b/i, /\brecommend (adding|that|to|improving|fixing|using)\b/i, /\brequest(ing)?\b/i, /\bfix(ed)?\b/i, /\badd(itional|ed)?\b/i,
            /\bbetter if\b/i, /\bit would be better\b/i, /\bplease\b/i, /\bupgrade/i,
            // Tagalog
            /\bsana\b/i, /\bdapat\b/i, /\bkung pwede\b/i, /\bkung maaari\b/i,
            /\bmas mabilis\b/i, /\bmas marami\b/i, /\bdagdagan\b/i, /\bmagdagdag\b/i,
            /\bi-?improve\b/i, /\bpaunlarin\b/i, /\bhiling\b/i, /\bkailangan\b/i,
            /\bkulang\b/i, /\bpaki-?(add|dagdagan|ayos)\b/i, /\blinisin\b/i,
            /\bpalawakin\b/i, /\bmagsanay\b/i, /\bmorena?\b/i, /\bdagdag\b/i,
            // Kapampangan
            /\bmisan\b/i, /\bkanita\b/i, /\bkulang\b/i, /\bdagdagan\b/i,
            /\bkung maliari\b/i, /\bdapat mu\b/i, /\bmagyawan\b/i, /\bablus\b/i,
            /\bsana la\b/i, /\bmisan pa\b/i
        ];
        return patterns.some(p => p.test(t));
    }

    /**
     * Measures how well a comment is covered by the trained vocabulary:
     * the fraction of stemmed unigram tokens that exist in this.vocabulary.
     * Low coverage means the comment contains words NB has never seen — its
     * confidence margin is then unreliable (it can be "confidently wrong"),
     * so the hybrid layer should escalate to Gemini.
     */
    getVocabularyCoverage(text) {
        const tokens = this.tokenize(text).filter(t => !t.includes('_'));
        if (tokens.length === 0) return 0;
        let known = 0;
        tokens.forEach(t => { if (this.vocabulary.has(t)) known++; });
        return known / tokens.length;
    }

    /**
     * Classify the CLIENT SUGGESTION & FEEDBACK comment — text-only, never SQD ratings.
     * Rules:
     *   no comment                          -> N/A
     *   positive without suggestions        -> Positive
     *   positive with improvement suggestion-> Neutral
     *   negative (with or without suggestion)-> Negative
     *   mixed (positive+negative aspects)   -> Negative
     */
    classifySuggestions(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) {
            return {
                sentiment: 'N/A',
                confidence: 0,
                scores: {},
                hasSuggestion: false,
                source: 'suggestions-text'
            };
        }
        const base = this.classify(trimmed);
        const hasSuggestion = this.detectImprovementSuggestion(trimmed);
        let sentiment = base.sentiment;
        if (sentiment === 'Positive' && hasSuggestion) {
            sentiment = 'Neutral';
        } else if (sentiment === 'Mixed') {
            sentiment = 'Negative';
        }
        return { ...base, sentiment, hasSuggestion, source: 'suggestions-text' };
    }

    /**
     * Hybrid satisfaction analysis — combines text sentiment with SQD ratings.
     * The NB classifier reads only the comment text, so lukewarm phrases
     * ("okay lang", "fine") are Neutral even when ratings are perfect.
     * Per the capstone paper: "analyze the comments AND ratings given by the
     * users to determine the level of satisfaction" — when the text sentiment
     * is Neutral, the SQD rating average decides the satisfaction level.
     */
    refineWithRatings(result, avgSQD) {
        const avg = parseFloat(avgSQD);
        if (result && result.sentiment === 'Neutral' && !isNaN(avg) && avg > 0) {
            if (avg >= 4.5) {
                return { ...result, sentiment: 'Positive', source: 'text+sqd' };
            }
            if (avg <= 2.5) {
                return { ...result, sentiment: 'Negative', source: 'text+sqd' };
            }
        }
        return result;
    }

    /**
     * Evaluate model performance against a trilingual validation dataset.
     * Computes Accuracy, Precision, Recall, F1-Score, and Confusion Matrix.
     */
    evaluateModel() {
        const validationSet = [
            // Positive Test Samples
            { text: "napakabilis ng serbisyo at napakabait ng staff", actual: "Positive" },
            { text: "mayap a serbisyu santing a resulta dakal a salamat", actual: "Positive" },
            { text: "outstanding customer service and fast assistance", actual: "Positive" },
            { text: "napakaayos ng opisina at napakagalang ng mga empleyado", actual: "Positive" },
            { text: "great experience smooth process helpful personnel", actual: "Positive" },
            { text: "mabilis ang pagproseso ng aking mga dokumento", actual: "Positive" },
            { text: "satisfied with the service outcome high quality", actual: "Positive" },

            // Negative Test Samples
            { text: "napakabagal ng linya at masungit ang nag-asikaso", actual: "Negative" },
            { text: "mabagut ing pamangaintay makadismaya ing pamangasiwa", actual: "Negative" },
            { text: "terrible service long waiting time disappointing", actual: "Negative" },
            { text: "pabaya ang mga tauhan walang disiplina ang empleyado", actual: "Negative" },
            { text: "horrible experience waste of time bad customer treatment", actual: "Negative" },
            { text: "matsura la ugali reng tauan masaguit makiusap", actual: "Negative" },
            { text: "mahal ang singil at maraming palakasan", actual: "Negative" },

            // Neutral Test Samples
            { text: "sakto lang ang oras ng pagproseso", actual: "Neutral" },
            { text: "average experience completed as expected", actual: "Neutral" },
            { text: "normal lang ang pila at oras ng pag-antay", actual: "Neutral" },
            { text: "standard procedure completed without issues", actual: "Neutral" },
            { text: "neither bad nor good just fine", actual: "Neutral" },
            { text: "maganda ang serbisyo pero sana dagdagan pa ang counters", actual: "Neutral" },
            { text: "good service but the waiting area needs more chairs", actual: "Neutral" },
            { text: "sana po magkaroon ng mas maraming signages", actual: "Neutral" },
            { text: "ang ganda ng service aburyan ke", actual: "Positive" },

            // Mixed Test Samples
            { text: "mabilis ang serbisyo pero medyo masungit ang staff", actual: "Mixed" },
            { text: "good facility but delayed release of documents", actual: "Mixed" },
            { text: "mabait ang empleyado pero napakamabagal ng linya", actual: "Mixed" },
            { text: "mayap ing opisina pero malwat ing pila", actual: "Mixed" }
        ];

        // Initialize Confusion Matrix: matrix[actual][predicted]
        const confusionMatrix = {};
        this.categories.forEach(catActual => {
            confusionMatrix[catActual] = {};
            this.categories.forEach(catPred => {
                confusionMatrix[catActual][catPred] = 0;
            });
        });

        let correctCount = 0;

        validationSet.forEach(sample => {
            const predResult = this.classify(sample.text);
            const predicted = predResult.sentiment;
            confusionMatrix[sample.actual][predicted]++;
            if (predicted === sample.actual) {
                correctCount++;
            }
        });

        const totalSamples = validationSet.length;
        const accuracy = parseFloat(((correctCount / totalSamples) * 100).toFixed(2));

        // Compute Precision, Recall, F1-Score per category
        const metricsPerCategory = {};
        let totalF1 = 0;

        this.categories.forEach(cat => {
            let tp = confusionMatrix[cat][cat];
            let fp = 0;
            let fn = 0;

            this.categories.forEach(otherCat => {
                if (otherCat !== cat) {
                    fp += confusionMatrix[otherCat][cat]; // Predicted cat, but actual was otherCat
                    fn += confusionMatrix[cat][otherCat]; // Actual cat, but predicted was otherCat
                }
            });

            const precision = (tp + fp) > 0 ? parseFloat((tp / (tp + fp)).toFixed(4)) : 0;
            const recall = (tp + fn) > 0 ? parseFloat((tp / (tp + fn)).toFixed(4)) : 0;
            const f1Score = (precision + recall) > 0 ? parseFloat(((2 * precision * recall) / (precision + recall)).toFixed(4)) : 0;

            metricsPerCategory[cat] = {
                precision: parseFloat((precision * 100).toFixed(1)),
                recall: parseFloat((recall * 100).toFixed(1)),
                f1Score: parseFloat((f1Score * 100).toFixed(1)),
                tp, fp, fn
            };

            totalF1 += f1Score;
        });

        const macroF1 = parseFloat(((totalF1 / this.categories.length) * 100).toFixed(2));

        return {
            totalSamples,
            correctCount,
            accuracy,
            macroF1,
            confusionMatrix,
            metricsPerCategory,
            vocabularySize: this.vocabulary.size,
            totalTrainingDocs: this.totalDocs
        };
    }
}

// Export a singleton instance
const naiveBayesClassifier = new NaiveBayesSentimentClassifier();
module.exports = naiveBayesClassifier;

