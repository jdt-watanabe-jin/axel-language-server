"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBuiltinCompletions = getBuiltinCompletions;
exports.getBuiltinHover = getBuiltinHover;
const BUILTIN_HOVER_INFO = new Map([
    ['abs', {
            signature: 'int abs(int)',
            description: 'Calculates the absolute value of an integer.'
        }],
    ['acos', {
            signature: 'double acos(double)',
            description: 'Calculates the arccosine value.'
        }],
    ['asin', {
            signature: 'double asin(double)',
            description: 'Calculates the arcsine value.'
        }],
    ['atan', {
            signature: 'double atan(double)',
            description: 'Calculates the arctangent value.'
        }],
    ['atan2', {
            signature: 'double atan2(double, double)',
            description: 'Calculates the arctangent value from two arguments.'
        }],
    ['printf', {
            signature: 'int printf(string format, ...)',
            description: 'AXEL standard library output function.'
        }],
    ['putchar', {
            signature: 'int putchar(int c)',
            description: 'Outputs one character.'
        }],
    ['puts', {
            signature: 'int puts(string s)',
            description: 'Outputs a string.'
        }],
    ['sprintf', {
            signature: 'void sprintf(string *buffer, string format [, arg]...)',
            description: 'Writes formatted data to a string buffer.'
        }],
    ['fopen', {
            signature: 'FILE *fopen(string filename, string mode)',
            description: 'Opens a file.'
        }],
    ['atof', {
            signature: 'double atof(char *s)\ndouble atof(string s)',
            description: 'Converts a string to a double value.'
        }],
    ['atoi', {
            signature: 'int atoi(char *s)\nint atoi(string s)',
            description: 'Converts a string to an integer value.'
        }],
    ['ceil', {
            signature: 'double ceil(double x)',
            description: 'Calculates the ceiling of a floating-point value.'
        }],
    ['cos', {
            signature: 'double cos(double)',
            description: 'Calculates the cosine value.'
        }],
    ['exp', {
            signature: 'double exp(double)',
            description: 'Calculates the exponential value.'
        }],
    ['fabs', {
            signature: 'double fabs(double)',
            description: 'Calculates the absolute value of a floating-point value.'
        }],
    ['floor', {
            signature: 'double floor(double x)',
            description: 'Calculates the floor of a floating-point value.'
        }],
    ['fmod', {
            signature: 'double fmod(double, double)',
            description: 'Calculates the floating-point remainder.'
        }],
    ['log', {
            signature: 'double log(double)',
            description: 'Calculates the natural logarithm.'
        }],
    ['log10', {
            signature: 'double log10(double)',
            description: 'Calculates the base-10 logarithm.'
        }],
    ['pow', {
            signature: 'double pow(double, double)',
            description: 'Calculates a power value.'
        }],
    ['rand', {
            signature: 'int rand()',
            description: 'Returns a pseudo-random integer.'
        }],
    ['round', {
            signature: 'int round(double x)',
            description: 'Rounds a floating-point value to an integer.'
        }],
    ['sin', {
            signature: 'double sin(double)',
            description: 'Calculates the sine value.'
        }],
    ['sincos', {
            signature: 'int sincos(double rad, double scl, double *sinv, double *cosv)',
            description: 'Calculates sine and cosine values.'
        }],
    ['sqrt', {
            signature: 'double sqrt(double)',
            description: 'Calculates the square root.'
        }],
    ['srand', {
            signature: 'void srand(int seed)',
            description: 'Sets the seed used by rand.'
        }],
    ['sleep', {
            signature: 'void sleep(int sec)',
            description: 'Suspends execution for the specified seconds.'
        }],
    ['msleep', {
            signature: 'void msleep(int msec)',
            description: 'Suspends execution for the specified milliseconds.'
        }],
    ['tan', {
            signature: 'double tan(double)',
            description: 'Calculates the tangent value.'
        }],
    ['time', {
            signature: 'int time(void *timer)',
            description: 'Returns the current time value.'
        }]
]);
function getBuiltinCompletions() {
    return Array.from(BUILTIN_HOVER_INFO.entries())
        .map(([name, info]) => ({
        name,
        kind: 'function',
        detail: info.signature,
        documentation: `${info.description} Source: docs/axel_users.pdf.`
    }))
        .sort((left, right) => left.name.localeCompare(right.name));
}
function getBuiltinHover(name) {
    const builtin = BUILTIN_HOVER_INFO.get(name);
    if (builtin === undefined) {
        return null;
    }
    const plainText = `${builtin.signature}\n${builtin.description}`;
    return {
        markdown: `\`\`\`axel\n${builtin.signature}\n\`\`\`\n\n${builtin.description}`,
        plainText
    };
}
//# sourceMappingURL=builtins.js.map