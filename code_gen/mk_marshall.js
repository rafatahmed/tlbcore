var fs = require('fs');
var util = require('util');
var _ = require('underscore');
var cgen = require('./cgen');
var gen_marshall = require('./gen_marshall');
var gen_functions = require('./gen_functions');




function main() {
  
  var watchFlag = false;
  var prefix = 'build.src/';
  var files = [];

  for (var argi=2; argi < process.argv.length; argi++) {
    var arg = process.argv[argi];

    switch (arg) {
    case '--watch':
      watchFlag = true;
      break;

    case '--prefix':
      prefix = process.argv[++argi];
      break;
      
    default:
      files.push(arg);
      if (watchFlag) {
        fs.watch(arg, processFiles);
      }
    }
  }

  processFiles();


  function processFiles() {
    var typereg = new gen_marshall.TypeRegistry('root');
    var filegen = new cgen.FileGen(prefix);

    if (1) {
      typereg.struct('TestStruct', 
                     ['foo', 'double'],
                     ['bar', 'int'],
                     ['buz', 'double']);

      var rtfn = typereg.addRtFunction('test1', {a: 'TestStruct'}, {b: 'TestStruct'});
      rtfn.node('scalar.+', [], ['a.foo', 'a.foo'], ['b.foo']);
      rtfn.node('scalar.+', [], ['a.bar', 'a.bar'], ['b.bar']);
      rtfn.node('scalar.atan', [], ['a.foo'], ['b.buz']);
      //rtfn.node('scalar.poly', [1,2,3,4,5,6], ['a.foo'], ['b.buz']);
    }

    _.each(files, function(fn) {
      util.puts('Load ' + fn);
      var rawFile = fs.readFileSync(fn, 'utf8');
      var wrappedFile = '(function(typereg, cgen, _, util) {\n' + rawFile + '\n})';
      var f = eval(wrappedFile);
      f(typereg, cgen, _, util);
    });
    typereg.emitAll(filegen);

    filegen.end();
  }

}

main();
