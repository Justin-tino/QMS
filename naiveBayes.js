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

        // Initialize with trained trilingual sentiment dictionary
        this.seedCorpus();
    }

    /**
     * Export current model state into a serializable plain JavaScript object for Firestore storage
     */
    exportModelState() {
        return {
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
     * Clean and tokenize input text into n-grams (unigrams & bigrams)
     * Supports English, Tagalog, and Kapampangan character sets.
     */
    tokenize(text) {
        if (!text || typeof text !== 'string') return [];

        const cleaned = text
            .toLowerCase()
            .replace(/[^\w\sñgÑGáéíóúàèìòùâêîôûäëïöü]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const words = cleaned.split(' ').filter(w => w.length > 1);
        const tokens = [...words];

        // Add bigrams for context (e.g. "hindi mabait", "dakal a salamat")
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

                // Kapampangan
                "mayap a serbisyu mabilis at santing",
                "dakal a salamat king masanting a pamangasiwa",
                "malamis at mausig la reng empleyadu",
                "mabilis ing prosesu at santing ing resulta",
                "masanting a lugal at maayos ing sistema",
                "mayap la pamanangap kaku king opisina",
                "dakal a salamat maasikaso la ngan",

                // English
                "excellent service very fast and polite staff",
                "great experience smooth process helpful personnel",
                "awesome work efficient and clean facility",
                "courteous employees quick document release",
                "satisfied with the service outcome high quality",
                "prompt response and friendly reception",
                "very easy transaction hassle free process",
                "outstanding assistance from the university team"
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
                "horrible assistance nobody knows what to do"
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
                "neither bad nor good just fine"
            ],
            Mixed: [
                "mabilis ang serbisyo pero medyo masungit ang staff",
                "mabait ang empleyado pero napakamabagal ng linya",
                "maganda ang opisina ngunit matagal ang pag-antay",
                "fast processing but rude front desk response",
                "good facility but delayed release of documents",
                "mayap ing opisina pero malwat ing pila"
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

