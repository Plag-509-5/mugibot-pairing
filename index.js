// index.js (dans le dossier session-generator)

const {
    default: makeWASocket,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    delay,
    PHONENUMBER_JID_EXT
} = require('baileys-x); // Ou 'baileys-x' si vous l'utilisez aussi ici
const { useMongoDBAuthState } = require('@whiskeysockets/baileys-mongo');
const { MongoClient } = require('mongodb');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const qrcode = require('qrcode');
const chalk = require('chalk'); // Pour les logs console stylisés

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- VOTRE CHAÎNE DE CONNEXION MONGO DB ATLAS (DOIT ÊTRE UNE VARIABLE D'ENVIRONNEMENT) ---
const MONGO_DB_URL = process.env.MONGO_DB_URL; // Sur Render, configurez MONGO_DB_URL
if (!MONGO_DB_URL) {
    console.error(chalk.red('FATAL ERROR: MONGO_DB_URL environment variable is not set.'));
    process.exit(1);
}

// Noms de la base de données et de la collection
const DB_NAME = 'baileys_sessions';
const COLLECTION_NAME = 'auth';

// Votre code d'appariement personnalisé
const CUSTOM_PAIRING_CODE = "MUGIWARA";

// Configuration du logger
const logger = pino({ level: 'silent' });

// Store pour les données en mémoire (optionnel, mais recommandé par Baileys)
const store = makeInMemoryStore({ logger });

// Variables globales pour le QR code, le code d'appariement et le statut de connexion
let qrCodeData = null;
let pairingCodeData = null;
let currentConnectionStatus = 'idle'; // 'idle', 'connecting', 'open', 'close', 'error'
let sock = null; // Instance de makeWASocket

async function startSessionGenerator(method, phoneNumber = null) {
    if (sock && (currentConnectionStatus === 'connecting' || currentConnectionStatus === 'open')) {
        console.log(chalk.yellow('Une session est déjà active ou en cours de connexion.'));
        return;
    }

    // Réinitialiser l'état précédent
    qrCodeData = null;
    pairingCodeData = null;
    currentConnectionStatus = 'connecting';
    console.log(chalk.blue(`Initiation de la connexion via ${method === 'pairing' ? 'Code d\'Appariement' : 'QR Code'}...`));

    let client;
    try {
        client = new MongoClient(MONGO_DB_URL);
        console.log(chalk.blue('Connexion à MongoDB...'));
        await client.connect();
        console.log(chalk.green('Connecté à MongoDB !'));

        const db = client.db(DB_NAME);
        const authCollection = db.collection(COLLECTION_NAME);

        const { state, saveCreds } = await useMongoDBAuthState(authCollection);

        const { version } = await fetchLatestBaileysVersion();
        console.log(chalk.cyan(`Utilisation de Baileys version ${version}`));

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: method !== 'pairing', // Afficher QR si pas de pairing code demandé
            browser: ['MUGIBOT-ULTRA Session Generator', 'Chrome', '1.0'],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            generateHighQualityLinkPreview: true,
            shouldSyncHistoryMessage: true,
            downloadHistory: true,
            syncFullHistory: true,
            qrTimeout: 60000 // QR code expire après 60 secondes
        });

        store.bind(sock.ev);

        // Si la méthode est "pairing", demander le code d'appariement
        if (method === 'pairing' && phoneNumber) {
            console.log(chalk.magenta(`Demande de code d'appariement pour : ${phoneNumber}`));
            // IMPORTANT : La manière dont baileys-x gère un `customPairingCode`
            // dans `requestPairingCode` est spécifique à ce fork.
            // Si `baileys-x` n'accepte pas le 2ème argument, retirez `, CUSTOM_PAIRING_CODE`
            try {
                const code = await sock.requestPairingCode(phoneNumber + PHONENUMBER_JID_EXT, CUSTOM_PAIRING_CODE);
                pairingCodeData = code;
                qrCodeData = null; // Clear QR data if pairing code is used
                console.log(chalk.green(`Code d'appariement généré : ${code}`));
            } catch (err) {
                console.error(chalk.red('Erreur lors de la génération du code d\'appariement:'), err);
                currentConnectionStatus = 'error';
                pairingCodeData = null;
                qrCodeData = null;
            }
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            currentConnectionStatus = connection; // Mettre à jour le statut global

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                if (reason === 401) { // Not Authenticated - Session invalidée
                    console.log(chalk.red('Session déconnectée (non authentifiée). Veuillez générer un nouveau code.'));
                    qrCodeData = null;
                    pairingCodeData = null;
                } else if (reason === 503) {
                     console.log(chalk.yellow('Service Baileys indisponible. Réessayez dans 10 secondes...'));
                     await delay(10000);
                     // Ne pas redémarrer automatiquement ici pour les services web
                } else {
                    console.log(chalk.red('Connexion fermée à cause de ', lastDisconnect?.error, ', pour d\'autres raisons.'));
                    qrCodeData = null;
                    pairingCodeData = null;
                }
                sock = null; // Réinitialiser l'instance sock
            } else if (connection === 'open') {
                console.log(chalk.green('Connexion ouverte ! La SESSION ID est maintenant stockée dans MongoDB.'));
                qrCodeData = null; // Effacer le QR/code une fois connecté
                pairingCodeData = null;
            }

            // Gérer le QR code, même si on a demandé un pairing code (Baileys peut fallback ou générer un QR si timeout ou erreur de pairing)
            if (qr && method === 'qr' && currentConnectionStatus !== 'open') {
                console.log(chalk.blue('QR Code disponible.'));
                qrCodeData = qr;
                pairingCodeData = null;
            } else if (qr && method === 'pairing' && currentConnectionStatus !== 'open') {
                 // Si un QR est généré alors qu'on attend un pairing code (ex: erreur), l'afficher
                 console.log(chalk.yellow('QR Code généré en fallback, si le code d\'appariement ne fonctionne pas.'));
                 qrCodeData = qr;
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error(chalk.red("Erreur critique lors du démarrage du générateur de session:"), error);
        qrCodeData = null;
        pairingCodeData = null;
        currentConnectionStatus = 'error';
        if (client) {
            await client.close();
            console.log(chalk.red('Connexion MongoDB fermée en raison d\'une erreur.'));
        }
        sock = null; // Réinitialiser l'instance sock
    }
}

// ---- Routes Express ----

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>MUGIBOT-ULTRA - Générateur de SESSION ID</title>
            <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
            <style>
                body {
                    font-family: 'Poppins', sans-serif;
                    margin: 0;
                    padding: 0;
                    background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
                    color: #e0e0e0;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    min-height: 100vh;
                    overflow-x: hidden;
                }
                .header {
                    background: rgba(0, 0, 0, 0.4);
                    width: 100%;
                    padding: 20px 0;
                    text-align: center;
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
                    margin-bottom: 30px;
                }
                .header h1 {
                    font-size: 2.8em;
                    color: #FFD700; /* Gold */
                    text-shadow: 0 0 10px rgba(255, 215, 0, 0.6);
                    margin: 0;
                }
                .header p {
                    font-size: 1.1em;
                    color: #bbb;
                    margin-top: 5px;
                }
                .container {
                    background: rgba(255, 255, 255, 0.08);
                    border-radius: 15px;
                    padding: 40px;
                    box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    max-width: 600px;
                    width: 90%;
                    text-align: center;
                    margin-bottom: 30px;
                }
                h2 {
                    color: #00FFFF; /* Cyan */
                    font-size: 1.8em;
                    margin-bottom: 25px;
                }
                .status-message {
                    font-size: 1.3em;
                    font-weight: 600;
                    margin-bottom: 25px;
                    color: #FF6347; /* Tomato */
                }
                .alert-success { color: #28a745; }
                .alert-info { color: #17a2b8; }
                .alert-error { color: #dc3545; }

                .form-group {
                    margin-bottom: 20px;
                    padding: 15px;
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 10px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                input[type="text"] {
                    width: calc(100% - 22px);
                    padding: 12px;
                    margin-top: 10px;
                    border: 1px solid #00FFFF;
                    border-radius: 8px;
                    background-color: rgba(255, 255, 255, 0.1);
                    color: #fff;
                    font-size: 1em;
                    transition: all 0.3s ease;
                }
                input[type="text"]::placeholder {
                    color: #aaa;
                }
                input[type="text"]:focus {
                    border-color: #FFD700;
                    box-shadow: 0 0 8px rgba(255, 215, 0, 0.5);
                    outline: none;
                }
                button {
                    background-color: #8A2BE2; /* BlueViolet */
                    color: white;
                    padding: 12px 25px;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 1.1em;
                    font-weight: 600;
                    margin: 10px;
                    transition: background-color 0.3s ease, transform 0.2s ease;
                }
                button:hover {
                    background-color: #6A1EB2;
                    transform: translateY(-2px);
                }
                button:disabled {
                    background-color: #555;
                    cursor: not-allowed;
                }

                #qr-image {
                    max-width: 250px;
                    height: auto;
                    border: 5px solid #00FFFF;
                    border-radius: 10px;
                    margin-top: 20px;
                }
                #pairing-code-display {
                    font-size: 2.2em;
                    font-weight: 700;
                    letter-spacing: 2px;
                    color: #FFD700;
                    margin-top: 20px;
                    padding: 15px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 10px;
                    word-break: break-all; /* Pour les longs codes */
                }
                .instructions {
                    font-size: 0.95em;
                    color: #ccc;
                    margin-top: 20px;
                    line-height: 1.5;
                }
                .footer {
                    margin-top: 40px;
                    font-size: 0.9em;
                    color: #aaa;
                    padding: 20px;
                    width: 100%;
                    text-align: center;
                    background: rgba(0, 0, 0, 0.2);
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                }
                .footer a {
                    color: #00FFFF;
                    text-decoration: none;
                    font-weight: 600;
                    transition: color 0.3s ease;
                }
                .footer a:hover {
                    color: #FFD700;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>MUGIBOT-ULTRA</h1>
                <p>Générateur de <span style="color:#FFD700;">SESSION ID</span> ultra rapide</p>
                <p>Créé par <span style="font-weight:bold; color:#00FF00;">MUGIWARA NO PLAG</span></p>
            </div>

            <div class="container">
                <p id="overall-status" class="status-message alert-info">Chargement de l'interface...</p>

                <div id="connection-options" style="display:none;">
                    <h2>Choisissez votre méthode de connexion :</h2>
                    <div class="form-group">
                        <form id="start-qr-form">
                            <p>Pour le <span style="font-weight:bold; color:#00FFFF;">QR Code</span> (méthode rapide) :</p>
                            <button type="submit" id="qrButton">Générer QR Code</button>
                        </form>
                    </div>
                    <div class="form-group">
                        <form id="start-pairing-form">
                            <p>Pour le <span style="font-weight:bold; color:#FFD700;">Code d'Appariement</span> (nécessite votre numéro) :</p>
                            <div>
                                <label for="phoneNumber" style="display:block; margin-bottom: 5px; color:#bbb;">Numéro de Téléphone (ex: 243890123456, sans le + ni espaces) :</label>
                                <input type="text" id="phoneNumber" name="phoneNumber" placeholder="Ex: 509xxxxxxx" required>
                            </div>
                            <button type="submit" id="pairingButton">Générer Code d'Appariement</button>
                        </form>
                    </div>
                </div>

                <div id="qr-display" style="display:none;">
                    <h2>Scannez ce <span style="color:#00FFFF;">QR Code</span></h2>
                    <img id="qr-image" src="" alt="QR Code">
                    <p class="instructions">Ouvrez WhatsApp sur votre téléphone (WhatsApp > Paramètres > Appareils connectés > Connecter un appareil) et scannez ce code.</p>
                </div>

                <div id="pairing-display" style="display:none;">
                    <h2>Votre <span style="color:#FFD700;">Code d'Appariement</span></h2>
                    <p id="pairing-code-display"></p>
                    <p class="instructions">Ouvrez WhatsApp sur votre téléphone, allez dans Paramètres > Appareils connectés > Connecter un appareil > Lier avec le numéro de téléphone et entrez le code ci-dessus.</p>
                </div>

                <div id="connected-section" style="display:none;">
                    <p class="status-message alert-success">🥳 Session ID connectée ! Vos identifiants sont sécurisés dans MongoDB.</p>
                    <p class="instructions">Vous pouvez maintenant démarrer votre bot principal (`index.js`).</p>
                </div>
            </div>

            <div class="footer">
                <p>✨ Connectez-vous avec la communauté MUGIWARA-ULTRA :</p>
                <p>🚀 ${chalk.hex('#00FFFF').bold('Développeur')} ? Rejoignez notre <a href="#" target="_blank">Groupe WhatsApp</a> pour collaborer !</p>
                <p>📢 Suivez notre <a href="#" target="_blank">Chaîne WhatsApp</a> pour les dernières mises à jour !</p>
            </div>

            <script>
                const overallStatus = document.getElementById('overall-status');
                const connectionOptions = document.getElementById('connection-options');
                const qrButton = document.getElementById('qrButton');
                const pairingButton = document.getElementById('pairingButton');
                const phoneNumberInput = document.getElementById('phoneNumber');

                const qrDisplay = document.getElementById('qr-display');
                const qrImage = document.getElementById('qr-image');

                const pairingDisplay = document.getElementById('pairing-display');
                const pairingCodeDisplay = document.getElementById('pairing-code-display');

                const connectedSection = document.getElementById('connected-section');

                function setStatus(message, type = 'info') {
                    overallStatus.textContent = message;
                    overallStatus.className = 'status-message alert-' + type;
                }

                function hideAllDisplaySections() {
                    qrDisplay.style.display = 'none';
                    pairingDisplay.style.display = 'none';
                    connectedSection.style.display = 'none';
                    connectionOptions.style.display = 'block';
                    qrButton.disabled = false;
                    pairingButton.disabled = false;
                    phoneNumberInput.disabled = false;
                }

                document.getElementById('start-qr-form').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    hideAllDisplaySections();
                    connectionOptions.style.display = 'none'; // Cacher les options
                    setStatus('Génération du QR Code en cours...', 'info');
                    qrButton.disabled = true;
                    pairingButton.disabled = true;
                    phoneNumberInput.disabled = true;

                    await fetch('/start-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ method: 'qr' })
                    });
                    getStatus(); // Commencer à rafraîchir le statut
                });

                document.getElementById('start-pairing-form').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const phoneNumber = phoneNumberInput.value.trim();
                    if (!phoneNumber) {
                        setStatus('Veuillez entrer un numéro de téléphone pour le code d\'appariement.', 'error');
                        return;
                    }
                    if (!/^\d+$/.test(phoneNumber)) { // Basic validation: digits only
                        setStatus('Le numéro de téléphone ne doit contenir que des chiffres.', 'error');
                        return;
                    }

                    hideAllDisplaySections();
                    connectionOptions.style.display = 'none'; // Cacher les options
                    setStatus('Génératio
