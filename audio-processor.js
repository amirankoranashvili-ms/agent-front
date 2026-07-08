class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferSize = 4800; // ~100ms at 48kHz native rate
  }

  process(inputs) {
    var input = inputs[0];
    if (!input || !input[0]) return true;

    var samples = input[0];
    for (var i = 0; i < samples.length; i++) {
      this._buffer.push(samples[i]);
    }

    while (this._buffer.length >= this._bufferSize) {
      var chunk = new Float32Array(this._buffer.splice(0, this._bufferSize));
      this.port.postMessage(chunk);
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
