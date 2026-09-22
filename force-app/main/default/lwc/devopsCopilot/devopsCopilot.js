import { LightningElement, track } from 'lwc';
import sendMessage from '@salesforce/apex/DevOpsCopilotController.sendMessage';
import pollTurn from '@salesforce/apex/DevOpsCopilotController.pollTurn';
import getUserStorySummary from '@salesforce/apex/DevOpsCopilotController.getUserStorySummary';

const POLL_MS = 1200;
const POLL_TIMEOUT_MS = 180000;

export default class DevopsCopilot extends LightningElement {
    @track messages = [];
    @track activity = [];
    @track summary = null;
    @track pendingConfirmation = null;

    draft = '';
    featureInput = '';
    isWorking = false;
    errorMessage = '';
    summaryNotFound = false;
    providerLabel = 'GitHub Actions';

    conversationId = null;
    _seq = 0;
    _pollHandle = null;
    _pollStarted = 0;
    _lastIndex = 0;

    sampleQuestions = [
        'Tell me everything about User Story 0001.',
        'What is blocking deployment to QA for 0001?',
        'Show me the latest commits for 0001.',
        'Why did the QA deployment fail?'
    ];

    // ---------------------------------------------------------------- getters

    get hasMessages() {
        return this.messages.length > 0;
    }

    get sendDisabled() {
        return this.isWorking || !this.draft || this.draft.trim().length === 0;
    }

    get shortSha() {
        const sha = this.summary && this.summary.latestCommit;
        return sha ? sha.substring(0, 7) : '—';
    }

    get prLabel() {
        if (!this.summary || !this.summary.prNumber) {
            return '—';
        }
        return '#' + this.summary.prNumber + ' · ' + (this.summary.prStatus || 'Open');
    }

    // ---------------------------------------------------------------- input

    handleInput(event) {
        this.draft = event.target.value;
    }

    handleKeyUp(event) {
        if (event.key === 'Enter' && !this.sendDisabled) {
            this.handleSend();
        }
    }

    handleSample(event) {
        this.draft = event.currentTarget.dataset.q;
        this.handleSend();
    }

    handleFeatureInput(event) {
        this.featureInput = event.target.value;
    }

    handleLoadFeature() {
        const id = (this.featureInput || '').trim();
        if (!id) {
            return;
        }
        this.summaryNotFound = false;
        getUserStorySummary({ featureId: id })
            .then((result) => {
                this.summary = result;
                this.summaryNotFound = !result;
            })
            .catch((error) => {
                this.summary = null;
                this.errorMessage = this._readError(error);
            });
    }

    // ---------------------------------------------------------------- chat

    handleSend() {
        const text = (this.draft || '').trim();
        if (!text || this.isWorking) {
            return;
        }

        this._appendMessage('user', 'You', [{ type: 'text', text }]);
        this.draft = '';
        this.errorMessage = '';
        this.pendingConfirmation = null;
        this.activity = [];
        this.isWorking = true;

        sendMessage({ message: text, conversationId: this.conversationId })
            .then((res) => {
                if (res.status === 'error') {
                    this._fail(res.error);
                    return;
                }
                this.conversationId = res.conversationId;
                this._lastIndex = 0;
                this._startPolling();
            })
            .catch((error) => this._fail(this._readError(error)));
    }

    /**
     * LWC cannot consume server-sent events, so a turn is polled. The
     * orchestrator returns everything produced since `sinceIndex`, which keeps
     * this from re-rendering the whole transcript on every tick.
     */
    _startPolling() {
        this._stopPolling();
        this._pollStarted = Date.now();

        this._pollHandle = setInterval(() => {
            if (Date.now() - this._pollStarted > POLL_TIMEOUT_MS) {
                this._fail('The copilot did not respond in time.');
                return;
            }

            pollTurn({ conversationId: this.conversationId, sinceIndex: this._lastIndex })
                .then((res) => {
                    if (!res) {
                        return;
                    }
                    if (res.status === 'error') {
                        this._fail(res.error);
                        return;
                    }

                    this.activity = (res.activity || []).map((a) => ({
                        name: a.name,
                        icon: a.state === 'ok' ? '✓' : a.state === 'failed' ? '✗' : '·'
                    }));

                    if (res.status === 'complete') {
                        this._stopPolling();
                        this.isWorking = false;
                        this.activity = [];
                        if (res.text) {
                            this._appendMessage('agent', 'Moon', this._parseBlocks(res.text));
                            this._detectConfirmation(res.text);
                        }
                    }
                })
                .catch((error) => this._fail(this._readError(error)));
        }, POLL_MS);
    }

    _stopPolling() {
        if (this._pollHandle) {
            clearInterval(this._pollHandle);
            this._pollHandle = null;
        }
    }

    // ------------------------------------------------------------ rendering

    /**
     * Split the reply into plain text and monospace runs. Fenced code and the
     * environment ladder read badly as flowing text, so they get their own
     * block class rather than being rendered as markdown.
     */
    _parseBlocks(text) {
        const blocks = [];
        const parts = String(text).split(/```/);
        parts.forEach((part, index) => {
            const body = index % 2 === 1 ? part.replace(/^[a-zA-Z]*\n/, '') : part;
            const trimmed = body.replace(/^\n+|\n+$/g, '');
            if (!trimmed) {
                return;
            }
            blocks.push({
                id: 'b' + this._seq++,
                text: trimmed,
                className: index % 2 === 1 ? 'mono-line' : 'text-line'
            });
        });
        return blocks.length ? blocks : [{ id: 'b' + this._seq++, text: String(text), className: 'text-line' }];
    }

    _appendMessage(kind, who, blocks) {
        this.messages = this.messages.concat([{
            id: 'm' + this._seq++,
            who,
            blocks,
            rowClass: kind === 'user' ? 'row-user' : 'row-agent',
            bubbleClass: kind === 'user' ? 'bubble-user' : 'bubble-agent'
        }]);
        this._scrollToEnd();
    }

    _scrollToEnd() {
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        window.setTimeout(() => {
            const el = this.refs && this.refs.transcript;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        }, 0);
    }

    /**
     * Surface the deployment summary as real buttons. The token itself stays on
     * the server — pressing "Yes, deploy" sends an ordinary confirming message,
     * and the orchestrator still re-validates before it triggers anything.
     */
    _detectConfirmation(text) {
        if (!/confirm|are you sure|deployment request/i.test(text)) {
            return;
        }
        const grab = (label, re) => {
            const m = re.exec(text);
            return m ? { label, value: m[1].trim() } : null;
        };
        const lines = [
            grab('Feature', /Feature:\s*(\S+)/i),
            grab('Branch', /Branch:\s*(\S+)/i),
            grab('PR', /PR:\s*(#?\S+)/i),
            grab('Source', /Source:\s*(\S+)/i),
            grab('Target', /Target:\s*(\S+)/i)
        ].filter(Boolean);

        if (lines.length >= 2) {
            this.pendingConfirmation = { lines };
        }
    }

    handleConfirmDeploy() {
        this.pendingConfirmation = null;
        this.draft = 'Yes, deploy it.';
        this.handleSend();
    }

    handleCancelDeploy() {
        this.pendingConfirmation = null;
        this._appendMessage('agent', 'Moon', [
            { id: 'b' + this._seq++, text: 'Deployment cancelled. Nothing was triggered.', className: 'text-line' }
        ]);
    }

    // ------------------------------------------------------------ errors

    _fail(message) {
        this._stopPolling();
        this.isWorking = false;
        this.activity = [];
        this.errorMessage = message || 'Something went wrong.';
    }

    _readError(error) {
        if (!error) {
            return 'Unknown error.';
        }
        if (error.body && error.body.message) {
            return error.body.message;
        }
        return error.message || String(error);
    }

    disconnectedCallback() {
        this._stopPolling();
    }
}
