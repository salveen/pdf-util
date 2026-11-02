<script lang="ts">
	import { compressPdf, type Level } from '$lib/compress';
	import { downloadBlob, formatSize } from '$lib/pdf';

	let file = $state<File | null>(null);
	let level = $state<Level>('MEDIUM');
	let outputName = $state('compressed.pdf');
	let processing = $state(false);
	let result = $state<{ success: boolean; message: string } | null>(null);
	let resultData = $state<Uint8Array | null>(null);
	// sizes in bytes, and the level that produced them
	let metrics = $state<{ original: number; compressed: number; level: Level } | null>(null);
	let dragover = $state(false);

	const smaller = $derived(metrics !== null && metrics.compressed < metrics.original);
	const reduction = $derived(
		metrics ? ((metrics.original - metrics.compressed) / metrics.original) * 100 : 0
	);

	const descriptions: Record<Level, string> = {
		LOW: 'Lossless: removes hidden data, leftovers and duplicates; images untouched',
		MEDIUM: 'Balanced: images recompressed at 75% JPEG quality, capped at 2000 px',
		HIGH: 'Aggressive: images capped at 1500 px and recompressed, some quality loss',
		EXTREME: 'Maximum: images capped at 1000 px, visible quality loss'
	};

	function percent(value: number) {
		if (value <= 0) return 'none';
		return value < 0.1 ? 'under 0.1%' : `${value.toFixed(1)}%`;
	}

	async function handleFile(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.files?.[0]) {
			file = input.files[0];
			outputName = `${file.name.replace(/\.pdf$/i, '')}_compressed.pdf`;
			result = null;
			resultData = null;
			metrics = null;
			input.value = '';
		}
	}

	async function handleDrop(event: DragEvent) {
		event.preventDefault();
		dragover = false;
		const f = event.dataTransfer?.files?.[0];
		if (f && f.name.toLowerCase().endsWith('.pdf')) {
			file = f;
			outputName = `${file.name.replace(/\.pdf$/i, '')}_compressed.pdf`;
			result = null;
			resultData = null;
			metrics = null;
		}
	}

	async function doCompress() {
		if (!file) return;
		processing = true;
		result = null;
		resultData = null;
		metrics = null;
		try {
			const data = await compressPdf(file, level);
			resultData = data;
			metrics = { original: file.size, compressed: data.length, level };
			result = { success: true, message: '' };
		} catch (e: unknown) {
			result = {
				success: false,
				message: `Error compressing PDF: ${e instanceof Error ? e.message : e}`
			};
		} finally {
			processing = false;
		}
	}

	function download() {
		if (resultData) {
			const name = outputName.endsWith('.pdf') ? outputName : outputName + '.pdf';
			downloadBlob(resultData, name);
		}
	}
</script>

<h3 class="section-header">Compress a PDF</h3>
<p class="section-desc">
	Shrink a PDF. Every level removes hidden metadata, leftovers from earlier edits and duplicate
	objects; higher levels also recompress images.
</p>

{#if !file}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="upload-area"
		class:dragover
		ondragover={(e) => { e.preventDefault(); dragover = true; }}
		ondragleave={() => (dragover = false)}
		ondrop={handleDrop}
	>
		<div class="upload-icon">📄</div>
		<div class="upload-text">Drop a PDF file here or <span>click to browse</span></div>
		<input type="file" accept=".pdf" onchange={handleFile} />
	</div>
{:else}
	<div class="file-info-box">
		<strong>{file.name}</strong>
		<span class="muted"> — Original size: </span>
		<strong>{formatSize(file.size)}</strong>
		<button
			class="remove-btn"
			style="float: right;"
			onclick={() => {
				file = null;
				result = null;
				resultData = null;
				metrics = null;
			}}
			title="Remove"
		>
			✕
		</button>
	</div>

	<div class="form-group">
		<label class="form-label" for="compress-level">Compression Level</label>
		<select id="compress-level" class="form-select" bind:value={level}>
			<option value="LOW">Low</option>
			<option value="MEDIUM">Medium</option>
			<option value="HIGH">High</option>
			<option value="EXTREME">Extreme</option>
		</select>
		<div class="form-hint">{descriptions[level]}</div>
	</div>

	<div class="form-group">
		<label class="form-label" for="compress-output">Output filename</label>
		<input id="compress-output" class="form-input" type="text" bind:value={outputName} />
	</div>

	<button class="btn-primary" onclick={doCompress} disabled={processing}>
		{#if processing}<span class="spinner"></span>{/if}
		Compress PDF
	</button>
{/if}

{#if result}
	<div style="margin-top: 1rem;">
		{#if result.success && metrics}
			{#if smaller}
				<div class="alert-success">✓ Compressed, with hidden data removed</div>
			{:else}
				<!-- The download is still the cleaned copy: handing back the original would hand
				     back its hidden data too. -->
				<div class="alert-info">
					No smaller at this level: {metrics.level === 'LOW'
						? 'Low leaves images untouched, so try Medium.'
						: 'its images are already compact, or of a kind left as they are so their colours stay exact.'}
					The download is a cleaned copy, with hidden data removed.
				</div>
			{/if}
			<div class="metrics-row">
				<div class="metric-card">
					<div class="metric-label">Original Size</div>
					<div class="metric-value">{formatSize(metrics.original)}</div>
				</div>
				<div class="metric-card">
					<div class="metric-label">Compressed Size</div>
					<div class="metric-value">{formatSize(metrics.compressed)}</div>
				</div>
				<div class="metric-card">
					<div class="metric-label">Reduction</div>
					<div class="metric-value">{percent(reduction)}</div>
				</div>
			</div>
			<button class="btn-download" onclick={download}>
				{smaller ? 'Download Compressed PDF' : 'Download Cleaned PDF'}
			</button>
		{:else}
			<div class="alert-error">{result.message}</div>
		{/if}
	</div>
{/if}
