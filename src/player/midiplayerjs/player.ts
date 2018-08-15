import { Utils } from './utils';
import { Track } from './track';

/**
 * Main player class.  Contains methods to load files, start, stop.
 * @param {function} - Callback to fire for each MIDI event.  Can also be added with on('midiEvent', fn)
 * @param {array} - Array buffer of MIDI file (optional).
 */
export class Player {
	private sampleRate: number = 5; // milliseconds
	private startTime: number = 0;
	private buffer = null;
	public division;
	private format;
	private setIntervalId = null;
	public tracks = [];
	public tempo: number = 120;
	private forcedTempo: number = -1;
	private originalTempo: number = -1;
	public startTick: number = 0;
	private tick = 0;
	private inLoop = false;
	public totalTicks = 0;
	public eventListeners = {};

	constructor(eventHandler, buffer?) {
		this.sampleRate = 5; // milliseconds
		this.startTime = 0;
		this.buffer = buffer || null;
		this.division;
		this.format;
		this.setIntervalId = null;
		this.tracks = [];
		this.tempo = 120;
		this.startTick = 0;
		this.tick = 0;
		this.inLoop = false;
		this.totalTicks = 0;
		this.eventListeners = {};

		if (typeof (eventHandler) === 'function') this.on('midiEvent', eventHandler);
	}


	/**
	 * Load an array buffer into the player.
	 * @param {array} arrayBuffer - Array buffer of file to be loaded.
	 * @return {Player}
	 */
	public loadArrayBuffer(arrayBuffer) {
		this.buffer = new Uint8Array(arrayBuffer);
		return this.fileLoaded();
	}

	/**
	 * Load a data URI into the player.
	 * @param {string} dataUri - Data URI to be loaded.
	 * @return {Player}
	 */
	loadDataUri(dataUri) {
		// convert base64 to raw binary data held in a string.
		// doesn't handle URLEncoded DataURIs - see SO answer #6850276 for code that does this
		var byteString = Utils.atob(dataUri.split(',')[1]);

		// write the bytes of the string to an ArrayBuffer
		var ia = new Uint8Array(byteString.length);
		for (var i = 0; i < byteString.length; i++) {
			ia[i] = byteString.charCodeAt(i);
		}

		this.buffer = ia;
		return this.fileLoaded();
	}

	/**
	 * Get filesize of loaded file in number of bytes.
	 * @return {number} - The filesize.
	 */
	getFilesize() {
		return this.buffer ? this.buffer.length : 0;
	}

	/**
	 * Parses file for necessary information and does a dry run to calculate total length.
	 * Populates this.events & this.totalTicks.
	 * @return {Player}
	 */
	fileLoaded() {
		if (!this.validate()) throw 'Invalid MIDI file; should start with MThd';
		return this.getDivision().getFormat().getTracks().dryRun();
	}

	/**
	 * Validates file using simple means - first four bytes should == MThd.
	 * @return {boolean}
	 */
	validate() {
		return Utils.bytesToLetters(this.buffer.slice(0, 4)) === 'MThd';
	}

	/**
	 * Gets MIDI file format for loaded file.
	 * @return {Player}
	 */
	getFormat() {
		/*
		MIDI files come in 3 variations:
		Format 0 which contain a single track
		Format 1 which contain one or more simultaneous tracks
		(ie all tracks are to be played simultaneously).
		Format 2 which contain one or more independant tracks
		(ie each track is to be played independantly of the others).
		return Utils.bytesToNumber(this.buffer.slice(8, 10));
		*/

		this.format = Utils.bytesToNumber(this.buffer.slice(8, 10));
		return this;
	}

	/**
	 * Parses out tracks, places them in this.tracks and initializes this.pointers
	 * @return {Player}
	 */
	getTracks() {
		this.tracks = [];
		this.buffer.forEach(function (byte, index) {
			if (Utils.bytesToLetters(this.buffer.slice(index, index + 4)) == 'MTrk') {
				let trackLength = Utils.bytesToNumber(this.buffer.slice(index + 4, index + 8));
				let newtrack: Track = new Track(this.tracks.length, this.buffer.slice(index + 8, index + 8 + trackLength));
				//patch, we force a tempo if needed
				newtrack.forcedTempo = this.forcedTempo;
				this.tracks.push(newtrack);

			}
		}, this);

		return this;
	}

	/**
	 * Force a tempo for all the played midi
	 * @param {number} bpm the forced tempo
	 */
	setForcedTempo(bpm: number) {
		this.tempo = bpm;
		this.forcedTempo = bpm;
		for (let i = 0; i < this.tracks.length; i++) {
			this.tracks[i].forcedTempo = bpm;
		}
	}

	/**
	 * Save the original tempo for this song
	 * @param {number} bpm the original tempo
	 */
	setOriginalTempo(bpm: number) {
		this.originalTempo = bpm;
		for (let i = 0; i < this.tracks.length; i++) {
			this.tracks[i].originalTempo = bpm;
		}
	}

	/**
	 * Enables a track for playing.
	 * @param {number} trackNumber - Track number
	 * @return {Player}
	 */
	enableTrack(trackNumber) {
		this.tracks[trackNumber - 1].enable();
		return this;
	}

	/**
	 * Disables a track for playing.
	 * @param {number} - Track number
	 * @return {Player}
	 */
	disableTrack(trackNumber) {
		this.tracks[trackNumber - 1].disable();
		return this;
	}

	/**
	 * Gets quarter note division of loaded MIDI file.
	 * @return {Player}
	 */
	getDivision() {
		this.division = Utils.bytesToNumber(this.buffer.slice(12, 14));
		return this;
	}

	/**
	 * The main play loop.
	 * @param {boolean} - Indicates whether or not this is being called simply for parsing purposes.  Disregards timing if so.
	 * @return {undefined}
	 */
	playLoop(dryRun) {
		if (!this.inLoop) {
			this.inLoop = true;
			this.tick = this.getCurrentTick();
			//console.log("tick:"+this.tick);

			this.tracks.forEach(function (track) {
				// Handle next event
				if (!dryRun && this.endOfFile()) {
					this.triggerPlayerEvent('endOfFile');
					this.stop();

				} else {
					let event = track.handleEvent(this.tick, dryRun);
					if (event && !dryRun) {
						this.emitEvent(event);
					} else if (event && dryRun && dryRun instanceof Function) {
						dryRun(event);
					}
				}

			}, this);

			if (!dryRun) this.triggerPlayerEvent('playing', { tick: this.tick });
			this.inLoop = false;
		}
	}

	/**
	 * Setter for startTime.
	 * @param {number} - UTC timestamp
	 */
	setStartTime(startTime) {
		this.startTime = startTime;
	}

	/**
	 * Start playing loaded MIDI file if not already playing.
	 * @return {Player}
	 */
	public play() {
		if (this.isPlaying()) throw 'Already playing...';

		// Initialize
		if (!this.startTime) this.startTime = (new Date()).getTime();

		// Start play loop
		//window.requestAnimationFrame(this.playLoop.bind(this));
		this.setIntervalId = setInterval(this.playLoop.bind(this), this.sampleRate);

		return this;
	}

	/**
	 * Pauses playback if playing.
	 * @return {Player}
	 */
	pause() {
		clearInterval(this.setIntervalId);
		this.setIntervalId = false;
		this.startTick = this.tick;
		this.startTime = 0;
		return this;
	}

	/**
	 * @name seek
	 * @description seek the player
	 * @param {number} tempo the original tempo of this track at the tick specified
	 * @param {number} tick the tick to seek
	 * @param {trackInfos[]} list of track info to restore the status
	 */
	seek(tempo: number, tick: number, trackInfos: any[]) {

		this.pause();
		let diff = this.forcedTempo - this.originalTempo;
		let newTempo = tempo + diff;
		this.tempo = newTempo;
		this.startTick = tick;
		this.tick = tick;
		for (let i = 0; i < trackInfos.length; i++) {
			diff = this.tracks[i].forcedTempo - this.tracks[i].originalTempo;
			newTempo = tempo + diff;
			this.tracks[i].tempo = newTempo;

			this.tracks[i].pointer = trackInfos[i].pointer;
			this.tracks[i].lastStatus = trackInfos[i].lastStatus;
			this.tracks[i].delta = trackInfos[i].delta;
			this.tracks[i].runningDelta = trackInfos[i].runningDelta;
			this.tracks[i].lastTick = trackInfos[i].lastTick;
		}
	}

	/**
	 * @name prepare
	 * @description prepare the midi to start playing the first note
	 */
	prepare() {
		if (this.startTick == 0) {
			this.playLoop(function (event) {
				if (event.name == "Note on") {
					this.pause();
				}
			}.bind(this));
		}
	}

	/**
	 * Stops playback if playing.
	 * @return {Player}
	 */
	stop() {
		clearInterval(this.setIntervalId);
		this.setIntervalId = false;
		this.startTick = 0;
		this.startTime = 0;
		this.resetTracks();
		return this;
	}

	/**
	 * Checks if player is playing
	 * @return {boolean}
	 */
	isPlaying() {
		return this.setIntervalId > 0;
	}

	/**
	 * Plays the loaded MIDI file without regard for timing and saves events in this.events.  Essentially used as a parser.
	 * @return {Player}
	 */
	dryRun() {
		// Reset tracks first
		this.resetTracks();
		while (!this.endOfFile()) this.playLoop(true);
		this.getEvents();
		this.totalTicks = this.getTotalTicks();
		this.startTick = 0;
		this.startTime = 0;

		// Leave tracks in pristine condish
		this.resetTracks();
		//console.log('Song time: ' + this.getSongTime() + ' seconds / ' + this.totalTicks + ' ticks.');

		this.triggerPlayerEvent('fileLoaded', this);
		return this;
	}

	/**
	 * Resets play pointers for all tracks.
	 * @return {Player}
	 */
	resetTracks() {
		this.tracks.forEach(track => track.reset());
		return this;
	}

	/**
	 * Gets an array of events grouped by track.
	 * @return {array}
	 */
	getEvents() {
		return this.tracks.map(track => track.events);
	}

	/**
	 * Gets total number of ticks in the loaded MIDI file.
	 * @return {number}
	 */
	getTotalTicks() {
		return Math.max.apply(null, this.tracks.map(track => track.delta));
	}

	/**
	 * Gets song duration in seconds.
	 * @return {number}
	 */
	getSongTime() {
		return this.totalTicks / this.division / this.tempo * 60;
	}

	/**
	 * Gets remaining number of seconds in playback.
	 * @return {number}
	 */
	getSongTimeRemaining() {
		return Math.round((this.totalTicks - this.tick) / this.division / this.tempo * 60);
	}

	/**
	 * Gets remaining percent of playback.
	 * @return {number}
	 */
	getSongPercentRemaining() {
		return Math.round(this.getSongTimeRemaining() / this.getSongTime() * 100);
	}

	/**
	 * Number of bytes processed in the loaded MIDI file.
	 * @return {number}
	 */
	bytesProcessed() {
		// Currently assume header chunk is strictly 14 bytes
		return 14 + this.tracks.length * 8 + this.tracks.reduce((a, b) => { return { pointer: a.pointer + b.pointer } }, { pointer: 0 }).pointer;
	}

	/**
	 * Determines if the player pointer has reached the end of the loaded MIDI file.
	 * @return {boolean}
	 */
	endOfFile() {
		return this.bytesProcessed() == this.buffer.length;
	}

	/**
	 * Gets the current tick number in playback.
	 * @return {number}
	 */
	getCurrentTick() {
		return Math.round(((new Date()).getTime() - this.startTime) / 1000 * (this.division * (this.tempo / 60))) + this.startTick;
	}

	/**
	 * Sends MIDI event out to listener.
	 * @param {object}
	 * @return {Player}
	 */
	emitEvent(event) {
		// Grab tempo if available.
		if (event.hasOwnProperty('name') && event.name === 'Set Tempo') {
			this.tempo = event.data;
		}
		this.triggerPlayerEvent('midiEvent', event);
		return this;
	}

	/**
	 * Subscribes events to listeners 
	 * @param {string} - Name of event to subscribe to.
	 * @param {function} - Callback to fire when event is broadcast.
	 * @return {Player}
	 */
	on(playerEvent, fn) {
		if (!this.eventListeners.hasOwnProperty(playerEvent)) this.eventListeners[playerEvent] = [];
		this.eventListeners[playerEvent].push(fn);
		return this;
	}

	/**
	 * Broadcasts event to trigger subscribed callbacks.
	 * @param {string} - Name of event.
	 * @param {object} - Data to be passed to subscriber callback.
	 * @return {Player}
	 */
	triggerPlayerEvent(playerEvent, data) {
		if (this.eventListeners.hasOwnProperty(playerEvent)) this.eventListeners[playerEvent].forEach(fn => fn(data || {}));
		return this;
	}

}