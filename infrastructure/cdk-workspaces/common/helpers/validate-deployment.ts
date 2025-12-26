import { Environment } from '../parameters/environments';
import { COLORS } from '../constants';
import * as readlineSync from 'readline-sync';

/**
 * Calculate the actual display width of a string excluding ANSI escape sequences
 */
function getVisibleLength(str: string): number {
    // Remove ANSI escape sequences
    // eslint-disable-next-line no-control-regex
    const stripped = str.replace(/\u001b\[\d+m/g, '');
    
    // Calculate length considering emojis and combining characters
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const segments = [...segmenter.segment(stripped)];
    
    let length = 0;
    for (const segment of segments) {
        const char = segment.segment;
        const code = char.codePointAt(0) || 0;
        
        // Check emoji ranges (broader support)
        if (
            (code >= 0x1F300 && code <= 0x1F9FF) || // Emojis
            (code >= 0x2600 && code <= 0x27BF) ||   // Miscellaneous Symbols
            (code >= 0xFE00 && code <= 0xFE0F) ||   // Variation Selectors
            char.length > 1                          // Surrogate pairs
        ) {
            length += 2; // Emojis count as 2 characters
        } else {
            length += 1;
        }
    }
    return length;
}

/**
 * Generate a box line with automatic padding adjustment
 * @param content - Content to display (including ANSI codes)
 * @param width - Box width (default 60)
 * @param align - Text alignment ('left' | 'center' | 'right')
 */
function padBoxLine(content: string, width = 60, align: 'left' | 'center' | 'right' = 'left'): string {
    const visibleLen = getVisibleLength(content);
    const padding = width - visibleLen;
    
    if (padding < 0) {
        // Truncate if content is too long
        return content.substring(0, width);
    }
    
    switch (align) {
        case 'center': {
            const leftPad = Math.floor(padding / 2);
            const rightPad = padding - leftPad;
            return ' '.repeat(leftPad) + content + ' '.repeat(rightPad);
        }
        case 'right':
            return ' '.repeat(padding) + content;
        case 'left':
        default:
            return content + ' '.repeat(padding);
    }
}

/**
 * Validate and confirm deployment
 * - Display project name and environment name
 * - Verify that account ID matches
 * - Request user confirmation for production environment
 * 
 * @param pjName - Project name
 * @param envName - Environment name
 * @param accountId - Expected AWS account ID (optional)
 * @throws {Error} If account ID does not match or user aborts deployment
 */
export function validateDeployment(pjName:string, envName:string, accountId?:string): void {

    console.log(`Project Name: ${pjName}`);
    console.log(`Environment Name: ${envName}`);
    if (accountId) {
        const isSameAccount: boolean = accountId === process.env.CDK_DEFAULT_ACCOUNT;
        if (!isSameAccount) {
            const BOX_WIDTH = 60;
            const warningBox = [
                '',
                `${COLORS.color_yellow}╭${'─'.repeat(BOX_WIDTH)}╮${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine(`${COLORS.color_bold} ❌ ACCOUNT MISMATCH WARNING${COLORS.color_reset}`, BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine('', BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine('  The provided account ID does not match the current', BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine('  CDK account.', BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine('', BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine(`${COLORS.color_dim}  Expected: ${accountId}${COLORS.color_reset}`, BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine(`${COLORS.color_dim}  Current:  ${process.env.CDK_DEFAULT_ACCOUNT}${COLORS.color_reset}`, BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}│${padBoxLine('', BOX_WIDTH)}${COLORS.color_yellow}│${COLORS.color_reset}`,
                `${COLORS.color_yellow}╰${'─'.repeat(BOX_WIDTH)}╯${COLORS.color_reset}`,
                '',
            ].join('\n');
            console.log(warningBox);
            throw new Error('Account ID mismatch. Deployment aborted.');
        }
    }

    const isProduction:boolean = envName === Environment.PRODUCTION;
    if (isProduction) {
        const BOX_WIDTH = 60;
        const cautionBox = [
            '',
            `${COLORS.color_red}╭${'─'.repeat(BOX_WIDTH)}╮${COLORS.color_reset}`,
            `${COLORS.color_red}│${padBoxLine(`${COLORS.color_bold} 🚨 PRODUCTION DEPLOYMENT${COLORS.color_reset}`, BOX_WIDTH)}${COLORS.color_red}│${COLORS.color_reset}`,
            `${COLORS.color_red}│${padBoxLine('', BOX_WIDTH)}${COLORS.color_red}│${COLORS.color_reset}`,
            `${COLORS.color_red}│${padBoxLine('  This is a production release.', BOX_WIDTH)}${COLORS.color_red}│${COLORS.color_reset}`,
            `${COLORS.color_red}│${padBoxLine('  Please review carefully before proceeding.', BOX_WIDTH)}${COLORS.color_red}│${COLORS.color_reset}`,
            `${COLORS.color_red}│${padBoxLine('', BOX_WIDTH)}${COLORS.color_red}│${COLORS.color_reset}`,
            `${COLORS.color_red}╰${'─'.repeat(BOX_WIDTH)}╯${COLORS.color_reset}`,
            '',
        ].join('\n');
        console.log(cautionBox);
        
        const answer = readlineSync.question('Are you sure you want to proceed? (yes/no): ');
        if (answer.toLowerCase() !== 'yes') {
            throw new Error('Deployment aborted by user.');
        } else {
            console.log(`${COLORS.color_green}✓${COLORS.color_reset} Proceeding with deployment...`);
        }
    }
}
