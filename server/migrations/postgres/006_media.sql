CREATE TABLE chapter_media (
 chapter_id INTEGER PRIMARY KEY REFERENCES chapters(id), source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
 processor_version INTEGER NOT NULL CHECK(processor_version>0), codec TEXT NOT NULL,
 sample_rate INTEGER NOT NULL CHECK(sample_rate>0), channels INTEGER NOT NULL CHECK(channels BETWEEN 1 AND 2),
 bits_per_sample INTEGER NOT NULL CHECK(bits_per_sample=16), duration_seconds DOUBLE PRECISION NOT NULL CHECK(duration_seconds>0),
 byte_length BIGINT NOT NULL CHECK(byte_length>0), rms DOUBLE PRECISION NOT NULL CHECK(rms BETWEEN 0 AND 1),
 waveform TEXT NOT NULL CHECK(jsonb_typeof(waveform::jsonb)='array'), processed_at TIMESTAMPTZ NOT NULL
);
