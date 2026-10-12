import test from 'node:test';
import assert from 'node:assert/strict';
import { searchKeywords } from '../CanvasInterface.js';

test('page filtering retains dates, relative dates, times, and actionable context', () => {
	for (const text of [
		'Office hours MONDAY', 'Available Tues.', 'Meet Thurs.', 'October 15', 'Sept. 15',
		'15/10/2026', '2026-10-15T20:00:00Z', '10/15', '15.10.2026',
		'Tomorrow', 'Next week', 'This weekend', 'In two days', 'Within 48 hours',
		'At 14:30', 'At 9 p.m.', 'By midnight', 'Due soon', 'Submission instructions',
		'Midterm information', 'Quiz preparation', 'On the 15th',
		'<p>Next&nbsp;week</p>', '<p>October <strong>15</strong></p>',
		'<p>15&#47;10&#47;2026</p>', '<p>&#77;onday</p>'
	]) assert.equal(searchKeywords(text), true, text);
});

test('page filtering skips empty content, ordinary prose, and HTML URL metadata', () => {
	for (const text of [
		null, undefined, '', '   ', 'Course overview and reading materials',
		'A summary of the theory; maybe useful',
		'<a href="/courses/123/files/456/download">Reading materials</a>',
		'<img src="https://canvas.test/files/456" alt="May" />',
		'<p>Reading materials</p><!-- Deadline Monday -->',
		'<script>const day = "Monday";</script><style>.may { color: red; }</style>',
		'https://canvas.test/courses/123/files/456/download?date=2026-10-15'
	]) assert.equal(searchKeywords(text), false, String(text));
});
